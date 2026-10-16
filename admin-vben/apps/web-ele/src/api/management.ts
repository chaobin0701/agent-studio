import { requestClient } from "./request";
export const managementApi = {
  get: <T = any>(url: string) => requestClient.get<T>(url),
  post: <T = any>(url: string, data: unknown = {}) =>
    requestClient.post<T>(url, data),
  patch: <T = any>(url: string, data: unknown) =>
    requestClient.request<T>(url, { method: "PATCH", data }),
  delete: <T = any>(url: string) => requestClient.delete<T>(url),
};
