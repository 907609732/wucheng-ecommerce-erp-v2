package sidecar

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"time"
)

type Request struct {
	V  int    `json:"v"`
	ID string `json:"id"`
	Op string `json:"op"`
	Config
}

type Response struct {
	V      int     `json:"v"`
	ID     string  `json:"id"`
	OK     bool    `json:"ok"`
	Result *Status `json:"result,omitempty"`
	Error  *Error  `json:"error,omitempty"`
}

// Run uses only the parent's private stdin/stdout pipes. Every operation after
// init authenticates the per-process nonce. No credentials go to command-line
// arguments, environment variables, the renderer, a listening control port, or
// protocol responses. EOF always closes this process's backend and tunnels.
func Run(ctx context.Context, input io.Reader, output io.Writer, init func(Config) (*Manager, error)) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 64*1024)
	encoder := json.NewEncoder(output)
	var manager *Manager
	var nonce string
	defer func() {
		if manager != nil {
			_ = manager.Close()
		}
	}()
	for scanner.Scan() {
		var request Request
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		decodeErr := decoder.Decode(&request)
		if decodeErr == nil {
			var extra any
			if decoder.Decode(&extra) != io.EOF {
				decodeErr = errors.New("extra JSON")
			}
		}
		response := Response{V: 1, ID: request.ID}
		var err error
		shutdown := false
		if decodeErr != nil || request.V != 1 || request.ID == "" || len(request.ID) > 128 {
			err = failure("INVALID_REQUEST", "a single versioned JSON object and request ID are required")
		} else if manager == nil {
			if request.Op != "init" {
				err = failure("NOT_INITIALIZED", "init must be the first operation")
			} else if _, validationErr := request.Config.validate(); validationErr != nil {
				err = failure("INVALID_CONFIG", validationErr.Error())
			} else {
				manager, err = init(request.Config)
				if err == nil {
					nonce = request.Nonce
				}
			}
		} else if subtle.ConstantTimeCompare([]byte(request.Nonce), []byte(nonce)) != 1 {
			err = failure("UNAUTHORIZED", "invalid process credential")
		} else if request.Op == "init" || request.ProxyPassword != "" || request.Origin != "" || request.StateDir != "" || request.Hostname != "" {
			err = failure("INVALID_REQUEST", "configuration cannot be changed after init")
		} else if request.Op == "shutdown" {
			status, stopErr := manager.Operate(ctx, "stop")
			err = stopErr
			if err == nil {
				shutdown = true
				response.Result = &status
			}
		} else {
			opCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			var status Status
			status, err = manager.Operate(opCtx, request.Op)
			cancel()
			if err == nil {
				response.Result = &status
			}
		}
		if err == nil && response.Result == nil && manager != nil {
			status, statusErr := manager.Operate(ctx, "status")
			err = statusErr
			if err == nil {
				response.Result = &status
			}
		}
		response.OK = err == nil
		if err != nil {
			var structured *Error
			if errors.As(err, &structured) {
				response.Error = structured
			} else {
				response.Error = &Error{"OPERATION_FAILED", "sidecar operation could not be completed"}
			}
		}
		if err = encoder.Encode(response); err != nil {
			return err
		}
		if shutdown {
			return nil
		}
		if err = ctx.Err(); err != nil {
			return err
		}
	}
	return scanner.Err()
}
