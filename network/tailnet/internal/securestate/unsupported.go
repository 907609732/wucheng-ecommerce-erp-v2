//go:build !windows

package securestate

import (
	"errors"
	"io"
)

func privateDirectory(string) error {
	return errors.New("this prototype requires Windows current-user DPAPI")
}
func protect([]byte) ([]byte, error)   { return nil, errors.New("DPAPI unavailable") }
func unprotect([]byte) ([]byte, error) { return nil, errors.New("DPAPI unavailable") }
func Acquire(string) (io.Closer, error) {
	return nil, errors.New("exclusive Windows state locking is unavailable")
}
