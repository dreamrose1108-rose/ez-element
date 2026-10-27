// Accounts not provisioned yet. Demo calls a local development process;
// build:production refuses to package demo mode or an empty environment.
export const config = { mode: 'demo' as 'demo' | 'cloud', envId: '', demoUrl: 'http://10.200.78.135:4174/api' };
