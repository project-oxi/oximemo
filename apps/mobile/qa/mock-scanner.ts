export const Format = { QRCode: "QR_CODE" };
export const checkPermissions = async () => "granted";
export const requestPermissions = async () => "granted";
export const scan = async () => ({ content: "OM1:local-ui-fixture" });
export const cancel = async () => undefined;
