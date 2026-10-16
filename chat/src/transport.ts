import { createVisitorTransport } from "./visitor-transport";
const query = new URLSearchParams(location.search).get("app");
const selected = query ?? import.meta.env.VITE_CHAT_APP_ID ?? "";
export const appId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
    selected,
  )
    ? selected
    : "";
let storage: Storage | undefined;
try {
  storage = localStorage;
} catch {}
export const request = createVisitorTransport(
  appId,
  fetch.bind(window),
  storage,
);
