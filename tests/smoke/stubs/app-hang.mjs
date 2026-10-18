// Test hook: an app that never begins listening, with a descendant process in the same group.
import { spawn } from 'node:child_process';
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(`GRANDCHILD:${gc.pid}`);
setInterval(() => {}, 1000);
