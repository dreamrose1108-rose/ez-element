export interface LoginPort {
  hasSession(): Promise<boolean>;
  getTicket(): Promise<string>;
  signIn(ticket: string): Promise<unknown>;
  signOut(): Promise<unknown>;
}
// One login in flight for all concurrent page requests; failures unlock retry.
export class LoginSession {
  private pending?: Promise<void>;
  constructor(private port: LoginPort) {}
  ensure(force = false): Promise<void> {
    if (this.pending) return this.pending;
    const work = (async () => {
      if (force) await this.port.signOut();
      else if (await this.port.hasSession()) return;
      await this.port.signIn(await this.port.getTicket());
    })();
    const tracked = work.finally(() => { if (this.pending === tracked) this.pending = undefined; });
    this.pending = tracked;
    return tracked;
  }
}
