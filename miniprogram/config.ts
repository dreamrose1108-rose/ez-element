// Accounts not provisioned yet. Demo calls a loopback-only development process;
// build:production refuses to package demo mode or an empty environment.
export const config = { mode: 'demo' as 'demo' | 'cloud', envId: '', demoUrl: 'http://127.0.0.1:4174/api' };
