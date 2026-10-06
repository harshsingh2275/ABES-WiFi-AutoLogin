//go:build windows

package main

import (
    "encoding/binary"
    "encoding/json"
    "errors"
    "io"
    "os"
    "strings"
    "sync"
    "syscall"
    "time"
    "unsafe"
)

type nativeRequest struct {
    Command    string `json:"command"`
    TargetSSID string `json:"targetSSID"`
}

type nativeStatus struct {
    Type   string `json:"type"`
    SSID   string `json:"ssid"`
    Active bool   `json:"active"`
    Error  string `json:"error,omitempty"`
}

const (
    wlanIntfOpcodeCurrentConnection = 7
    wlanInterfaceStateConnected     = 1
    wlanNotificationSourceACM       = 0x00000008

    wlanNotificationACMConnectionStart    = 0x00000009
    wlanNotificationACMConnectionComplete = 0x0000000A
    wlanNotificationACMInterfaceArrival   = 0x0000000D
    wlanNotificationACMInterfaceRemoval   = 0x0000000E
    wlanNotificationACMDisconnecting      = 0x00000014
    wlanNotificationACMDisconnected       = 0x00000015
)

var (
    wlanapi                = syscall.NewLazyDLL("wlanapi.dll")
    procWlanOpenHandle     = wlanapi.NewProc("WlanOpenHandle")
    procWlanEnumInterfaces = wlanapi.NewProc("WlanEnumInterfaces")
    procWlanQueryInterface = wlanapi.NewProc("WlanQueryInterface")
    procWlanFreeMemory     = wlanapi.NewProc("WlanFreeMemory")
    procWlanCloseHandle    = wlanapi.NewProc("WlanCloseHandle")
    procWlanRegisterNotify = wlanapi.NewProc("WlanRegisterNotification")
)

var (
    notifyCh = make(chan struct{}, 1)
    writeMu  sync.Mutex
)

// The callback is kept globally for the lifetime of the process.
var notificationCallback = syscall.NewCallback(wlanNotificationCallback)

func main() {
    if err := run(); err != nil {
        _, _ = os.Stderr.WriteString("ABES WiFi helper: " + err.Error() + "\n")
    }
}

func run() error {
    var negotiatedVersion uint32
    var clientHandle uintptr

    ret, _, _ := procWlanOpenHandle.Call(
        uintptr(2),
        0,
        uintptr(unsafe.Pointer(&negotiatedVersion)),
        uintptr(unsafe.Pointer(&clientHandle)),
    )
    if ret != 0 {
        return syscall.Errno(ret)
    }
    defer procWlanCloseHandle.Call(clientHandle, 0)

    payload, err := readNativeMessage(os.Stdin)
    if err != nil {
        return err
    }

    var req nativeRequest
    if err := json.Unmarshal(payload, &req); err != nil {
        return errors.New("invalid JSON request")
    }

    targetSSID := strings.TrimSpace(req.TargetSSID)
    if targetSSID == "" {
        targetSSID = "ABESEC"
    }

    switch req.Command {
    case "getStatusOnce":
        return sendCurrentStatus(clientHandle, targetSSID)

    case "startWatch":
        if err := registerNotifications(clientHandle); err != nil {
            return err
        }
        defer unregisterNotifications(clientHandle)

        // Initial status is always returned when real-time mode starts.
        if err := sendCurrentStatus(clientHandle, targetSSID); err != nil {
            return err
        }

        requestCh := make(chan nativeRequest)
        requestErrCh := make(chan error, 1)

        go func() {
            for {
                payload, err := readNativeMessage(os.Stdin)
                if err != nil {
                    requestErrCh <- err
                    return
                }

                var message nativeRequest
                if err := json.Unmarshal(payload, &message); err != nil {
                    requestErrCh <- errors.New("invalid JSON request")
                    return
                }
                requestCh <- message
            }
        }()

        for {
            select {
            case message := <-requestCh:
                switch message.Command {
                case "getStatus", "setTargetSSID":
                    if strings.TrimSpace(message.TargetSSID) != "" {
                        targetSSID = strings.TrimSpace(message.TargetSSID)
                    }
                    if err := sendCurrentStatus(clientHandle, targetSSID); err != nil {
                        return err
                    }
                }

            case <-requestErrCh:
                // Native messaging closed the input stream. Exit normally.
                return nil

            case <-notifyCh:
                // Give WLAN AutoConfig a moment to settle before querying it.
                time.Sleep(150 * time.Millisecond)
                if err := sendCurrentStatus(clientHandle, targetSSID); err != nil {
                    return err
                }
            }
        }

    default:
        return errors.New("unknown command")
    }
}

func registerNotifications(clientHandle uintptr) error {
    ret, _, _ := procWlanRegisterNotify.Call(
        clientHandle,
        uintptr(wlanNotificationSourceACM),
        1,
        notificationCallback,
        0,
        0,
        0,
    )
    if ret != 0 {
        return errors.New("could not register Wi-Fi change notifications")
    }
    return nil
}

func unregisterNotifications(clientHandle uintptr) {
    procWlanRegisterNotify.Call(clientHandle, 0, 0, 0, 0, 0, 0)
}

func sendCurrentStatus(clientHandle uintptr, targetSSID string) error {
    ssid, connected, err := currentSSID(clientHandle)
    if err != nil {
        return sendStatus(nativeStatus{
            Type:   "wifiStatus",
            SSID:   "",
            Active: false,
            Error:  "Could not read Wi-Fi state",
        })
    }

    ssid = strings.TrimSpace(ssid)
    active := connected && strings.EqualFold(ssid, targetSSID)

    return sendStatus(nativeStatus{
        Type:   "wifiStatus",
        SSID:   ssid,
        Active: active,
    })
}

func wlanNotificationCallback(data uintptr, context uintptr) uintptr {
    if data == 0 {
        return 0
    }

    source := *(*uint32)(unsafe.Pointer(data))
    code := *(*uint32)(unsafe.Pointer(data + 4))

    if source != wlanNotificationSourceACM {
        return 0
    }

    switch code {
    case wlanNotificationACMConnectionStart,
        wlanNotificationACMConnectionComplete,
        wlanNotificationACMInterfaceArrival,
        wlanNotificationACMInterfaceRemoval,
        wlanNotificationACMDisconnecting,
        wlanNotificationACMDisconnected:
        select {
        case notifyCh <- struct{}{}:
        default:
            // Coalesce bursts of WLAN notifications.
        }
    }

    return 0
}

func currentSSID(clientHandle uintptr) (string, bool, error) {
    var list uintptr
    ret, _, _ := procWlanEnumInterfaces.Call(
        clientHandle,
        0,
        uintptr(unsafe.Pointer(&list)),
    )
    if ret != 0 {
        return "", false, syscall.Errno(ret)
    }
    if list == 0 {
        return "", false, nil
    }
    defer procWlanFreeMemory.Call(list)

    numberOfItems := *(*uint32)(unsafe.Pointer(list))
    if numberOfItems == 0 {
        return "", false, nil
    }

    // WLAN_INTERFACE_INFO_LIST layout used by Windows x64.
    const interfaceInfoSize = uintptr(532)
    const interfaceInfoListHeaderSize = uintptr(8)
    const interfaceStateOffset = uintptr(16 + 512)

    for i := uint32(0); i < numberOfItems; i++ {
        entry := list + interfaceInfoListHeaderSize + uintptr(i)*interfaceInfoSize
        state := *(*uint32)(unsafe.Pointer(entry + interfaceStateOffset))
        if state != wlanInterfaceStateConnected {
            continue
        }

        attrs, err := queryConnectionAttributes(clientHandle, entry)
        if err != nil || attrs == 0 {
            continue
        }

        // WLAN_CONNECTION_ATTRIBUTES association attributes contain DOT11_SSID.
        const associationAttributesOffset = uintptr(520)
        const ssidBytesOffset = uintptr(4)

        ssidLen := *(*uint32)(unsafe.Pointer(attrs + associationAttributesOffset))
        if ssidLen > 32 {
            ssidLen = 32
        }

        ssidBytes := unsafe.Slice(
            (*byte)(unsafe.Pointer(attrs+associationAttributesOffset+ssidBytesOffset)),
            ssidLen,
        )
        ssid := string(ssidBytes)

        procWlanFreeMemory.Call(attrs)
        return ssid, true, nil
    }

    return "", false, nil
}

func queryConnectionAttributes(clientHandle uintptr, interfaceInfo uintptr) (uintptr, error) {
    var dataSize uint32
    var data uintptr
    var opcodeType uint32

    ret, _, _ := procWlanQueryInterface.Call(
        clientHandle,
        interfaceInfo,
        wlanIntfOpcodeCurrentConnection,
        0,
        uintptr(unsafe.Pointer(&dataSize)),
        uintptr(unsafe.Pointer(&data)),
        uintptr(unsafe.Pointer(&opcodeType)),
    )
    if ret != 0 {
        return 0, syscall.Errno(ret)
    }

    return data, nil
}

func readNativeMessage(r io.Reader) ([]byte, error) {
    var length uint32
    if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
        return nil, err
    }
    if length == 0 || length > 1024*1024 {
        return nil, errors.New("invalid native message size")
    }

    payload := make([]byte, length)
    if _, err := io.ReadFull(r, payload); err != nil {
        return nil, err
    }
    return payload, nil
}

func sendStatus(status nativeStatus) error {
    payload, err := json.Marshal(status)
    if err != nil {
        return err
    }

    var length [4]byte
    binary.LittleEndian.PutUint32(length[:], uint32(len(payload)))

    writeMu.Lock()
    defer writeMu.Unlock()

    if _, err := os.Stdout.Write(length[:]); err != nil {
        return err
    }
    _, err = os.Stdout.Write(payload)
    return err
}
