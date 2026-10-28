//go:build windows

package securestate

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

func privateDirectory(dir string) error {
	if !filepath.IsAbs(dir) {
		return errors.New("absolute node state directory required")
	}
	if filepath.Clean(dir) == filepath.VolumeName(dir)+string(filepath.Separator) {
		return errors.New("a volume root cannot be a private state directory")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("state directory cannot be a link")
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil || !strings.EqualFold(filepath.Clean(dir), filepath.Clean(resolved)) {
		return errors.New("state directory ancestors cannot be links")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}

func transform(data []byte, decrypt bool) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty protected state")
	}
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var out windows.DataBlob
	var err error
	if decrypt {
		err = windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	} else {
		err = windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(out.Data))))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

func protect(data []byte) ([]byte, error)   { return transform(data, false) }
func unprotect(data []byte) ([]byte, error) { return transform(data, true) }

type stateLock struct {
	file       *os.File
	overlapped windows.Overlapped
	once       sync.Once
	closeError error
}

func Acquire(dir string) (io.Closer, error) {
	if err := privateDirectory(dir); err != nil {
		return nil, err
	}
	lockName, err := windows.UTF16PtrFromString(filepath.Join(dir, "sidecar.lock"))
	if err != nil {
		return nil, err
	}
	// Intentionally omit FILE_SHARE_DELETE: an owned lock cannot be replaced by
	// deleting/renaming its pathname while this process still holds its handle.
	handle, err := windows.CreateFile(lockName, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(handle), "private-state-lock")
	lock := &stateLock{file: file}
	if err = windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &lock.overlapped); err != nil {
		file.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, ErrStateInUse
		}
		return nil, err
	}
	return lock, nil
}

func (s *stateLock) Close() error {
	s.once.Do(func() {
		s.closeError = errors.Join(windows.UnlockFileEx(windows.Handle(s.file.Fd()), 0, 1, 0, &s.overlapped), s.file.Close())
	})
	return s.closeError
}
