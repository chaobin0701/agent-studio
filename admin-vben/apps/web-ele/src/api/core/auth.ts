import { requestClient } from '#/api/request';

export interface LoginParams {
  username: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  admin: {
    id: number;
    email: null | string;
    username: null | string;
    displayName: string;
  };
}

export function loginApi({ username, password }: LoginParams) {
  return requestClient.post<LoginResult>('/auth/login', { email: username, password });
}
