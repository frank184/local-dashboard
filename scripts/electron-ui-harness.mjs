#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args.shift() || 'help';
const option = (name, fallback = '') => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const port = Number(option('port', '9222'));

function usage() {
  console.log(`Electron UI harness (connects to an app started with --remote-debugging-port=9222)

Commands:
  snapshot --out=/tmp/dashboard.png
  inspect '.calendar-event-block'
  click '.calendar-event-block'
  drag '.calendar-event-block' '.calendar-day-column[data-calendar-date="2026-10-27"]' --hold=1000 --out=/tmp/calendar-move
  eval 'JSON.stringify({url: location.hash})'

Drag dispatches pointer events through the renderer and captures hold, target, and
drop frames when --out is supplied. Use a disposable Electron profile for changes.`);
}

if (command === 'help' || command === '--help') { usage(); process.exit(0); }

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((item) => item.type === 'page');
if (!target) throw new Error(`No Electron page found on DevTools port ${port}.`);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let messageId = 0;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id) return;
  pending.get(message.id)?.(message);
  pending.delete(message.id);
};
const call = (method, params = {}) => new Promise((resolve) => {
  const id = ++messageId;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.error) throw new Error(response.error.message);
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
  return response.result?.result?.value;
};
const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
const saveScreenshot = async (file) => {
  await call('Page.enable');
  const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, Buffer.from(capture.result.data, 'base64'));
  console.log(file);
};

try {
  await call('Runtime.enable');
  switch (command) {
    case 'snapshot': {
      await saveScreenshot(option('out', '/tmp/local-dashboard.png'));
      break;
    }
    case 'inspect': {
      const selector = args.find((arg) => !arg.startsWith('--'));
      if (!selector) throw new Error('Provide a CSS selector to inspect.');
      const result = await evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName, className: el.className, text: el.innerText?.slice(0, 180), rect: { x: r.x, y: r.y, width: r.width, height: r.height } }; }))`);
      console.log(result);
      break;
    }
    case 'click': {
      const selector = args.find((arg) => !arg.startsWith('--'));
      if (!selector) throw new Error('Provide a CSS selector to click.');
      const result = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('No element matches '+${JSON.stringify(selector)});el.click();return el.innerText||el.getAttribute('aria-label')||el.tagName})()`);
      console.log(result);
      break;
    }
    case 'eval': {
      const expression = args.filter((arg) => !arg.startsWith('--')).join(' ');
      if (!expression) throw new Error('Provide a JavaScript expression.');
      console.log(await evaluate(expression));
      break;
    }
    case 'drag': {
      const selectors = args.filter((arg) => !arg.startsWith('--'));
      const [sourceSelector, targetSelector] = selectors;
      if (!sourceSelector || !targetSelector) throw new Error('Provide source and target CSS selectors.');
      const hold = Math.max(100, Number(option('hold', '1000')));
      const targetXRatio = Math.min(1, Math.max(0, Number(option('x', '.5'))));
      const targetYRatio = Math.min(1, Math.max(0, Number(option('y', '.75'))));
      const prefix = option('out');
      const positions = await evaluate(`(()=>{const source=document.querySelector(${JSON.stringify(sourceSelector)});const target=document.querySelector(${JSON.stringify(targetSelector)});if(!source||!target)throw Error('Source or target selector not found');const a=source.getBoundingClientRect();const b=target.getBoundingClientRect();return {source:{x:a.x+a.width/2,y:a.y+a.height/2},target:{x:b.x+b.width*${targetXRatio},y:b.y+b.height*${targetYRatio}}}})()`);
      const pointerId = Math.floor(Date.now() % 1_000_000) + 1;
      const dispatch = (type, point) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(sourceSelector)});el.dispatchEvent(new PointerEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,pointerId:${pointerId},button:0,clientX:${point.x},clientY:${point.y}}));return true})()`);
      await dispatch('pointerdown', positions.source);
      await sleep(hold + 80);
      if (prefix) await saveScreenshot(`${prefix}-hold.png`);
      await dispatch('pointermove', positions.target);
      await sleep(80);
      if (prefix) await saveScreenshot(`${prefix}-target.png`);
      await dispatch('pointerup', positions.target);
      await sleep(600);
      if (prefix) await saveScreenshot(`${prefix}-drop.png`);
      console.log(await evaluate(`JSON.stringify({ghost:!!document.querySelector('.calendar-event-drag-ghost'),dragging:document.querySelector('.is-drag-source')?.innerText||null,target:document.querySelector('.is-drop-target')?.dataset.calendarDate||null})`));
      break;
    }
    default:
      usage();
  }
} finally {
  socket.close();
}
