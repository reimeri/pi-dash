// Browser WebSocket clients may only send close code 1000 or application
// codes in the 3000–4999 range. Keep client-initiated recovery codes away
// from the server's 4001 authentication-required signal.
export const CLIENT_PROTOCOL_ERROR_CLOSE_CODE = 4400;
export const CLIENT_RECONNECT_CLOSE_CODE = 4401;
