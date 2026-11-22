package main

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

const (
	scramIterations = 4096
	scramSaltBytes  = 16
)

// generateSCRAMSHA256 builds a PostgreSQL-compatible RFC 5802/5803/7677
// SCRAM-SHA-256 password verifier so plaintext passwords never appear in SQL DDL.
func generateSCRAMSHA256(password string) (string, error) {
	salt := make([]byte, scramSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate scram salt: %w", err)
	}
	return formatSCRAMSHA256(password, salt, scramIterations)
}

func formatSCRAMSHA256(password string, salt []byte, iterations int) (string, error) {
	saltedPassword, err := pbkdf2.Key(sha256.New, password, salt, iterations, sha256.Size)
	if err != nil {
		return "", fmt.Errorf("derive scram key: %w", err)
	}

	clientMac := hmac.New(sha256.New, saltedPassword)
	clientMac.Write([]byte("Client Key"))
	clientKey := clientMac.Sum(nil)

	storedKey := sha256.Sum256(clientKey)

	serverMac := hmac.New(sha256.New, saltedPassword)
	serverMac.Write([]byte("Server Key"))
	serverKey := serverMac.Sum(nil)

	return fmt.Sprintf(
		"SCRAM-SHA-256$%d:%s$%s:%s",
		iterations,
		base64.StdEncoding.EncodeToString(salt),
		base64.StdEncoding.EncodeToString(storedKey[:]),
		base64.StdEncoding.EncodeToString(serverKey),
	), nil
}
