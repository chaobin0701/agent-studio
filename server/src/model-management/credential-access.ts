import { randomBytes, createHash } from 'node:crypto';
import { ForbiddenException, BadRequestException } from '@nestjs/common';

export function credentialPreview(secret: string): string {
  if (secret.length <= 8) return '••••••••';
  if (secret.length < 16) return `••••••${secret.slice(-2)}`;
  return `${secret.slice(0,4)}••••••${secret.slice(-4)}`;
}
/** Grants are short-lived, resource/actor/workspace/revision bound, never persisted. */
export class CredentialAccess {
  private grants = new Map<string,{scope:string;expires:number}>();
  private failures = new Map<string,{count:number;expires:number}>();
  checkAttempts(scope:string) {
    const entry=this.failures.get(scope);
    if(entry && entry.expires>Date.now() && entry.count>=5) throw new BadRequestException('验证次数过多，请十分钟后重试');
  }
  failed(scope:string) {
    this.checkAttempts(scope);
    const previous=this.failures.get(scope);
    this.failures.set(scope,{count:previous && previous.expires>Date.now()?previous.count+1:1,expires:Date.now()+600_000});
    this.prune();
  }
  succeeded(scope:string) {this.failures.delete(scope);}
  grant(scope:string) {
    this.prune();
    const token=randomBytes(32).toString('base64url');
    this.grants.set(this.hash(token),{scope,expires:Date.now()+300_000});
    return {token,expiresIn:300};
  }
  verify(token:string,scope:string) {
    const grant=this.grants.get(this.hash(token));
    if(!grant || grant.scope!==scope || grant.expires<=Date.now()) throw new ForbiddenException('凭据查看授权已失效，请重新验证身份');
  }
  private hash(token:string) {return createHash('sha256').update(token).digest('hex');}
  private prune() {
    for(const map of [this.grants,this.failures])for(const [key,value] of map)if(value.expires<=Date.now())map.delete(key);
    if(this.grants.size>5000)this.grants.clear();
    if(this.failures.size>5000)this.failures.clear();
  }
}
