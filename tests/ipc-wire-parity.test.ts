import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { validateIpcArguments } from '../electron/ipc-contracts';

function callsIn(file: ts.SourceFile, callee: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === callee) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

function channel(call: ts.CallExpression): string {
  const name = call.arguments[0];
  if (!name || !ts.isStringLiteral(name)) throw new Error('Declare each IPC channel as a string literal.');
  return name.text;
}

it('checks every preload channel against main registration, input validation and result type', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const configPath = resolve(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const preloadPath = resolve(root, 'electron/preload.cts');
  const mainPath = resolve(root, 'electron/main.ts');
  const program = ts.createProgram([preloadPath, mainPath], options);
  const checker = program.getTypeChecker();
  const preload = program.getSourceFile(preloadPath)!;
  const main = program.getSourceFile(mainPath)!;
  const invokes = callsIn(preload, 'ipcRenderer.invoke');
  const handlers = callsIn(main, 'handle');
  const registered = handlers.map(channel);
  const exposed = invokes.map(channel);
  expect(exposed.length).toBeGreaterThan(100);
  expect(registered.sort()).toEqual(exposed.sort());
  expect(new Set(registered).size).toBe(registered.length);
  const callbacks = new Map(handlers.map((call) => [channel(call), call.arguments[1]]));
  const failures: string[] = [];
  for (const invoke of invokes) {
    const name = channel(invoke);
    try { validateIpcArguments(name, []); }
    catch (error) {
      if ((error as Error).message === 'Unknown browser command') failures.push(name + ' has no runtime input rule.');
    }
    // Reconnect is triggered by an online event. Its result is deliberately
    // discarded and does not cross the exposed API.
    if (name === 'vault:reconnect') continue;
    const wrapper = invoke.parent;
    const callback = callbacks.get(name);
    if (!ts.isArrowFunction(wrapper) || !callback || !ts.isArrowFunction(callback)) {
      failures.push(name + ' must have a typed preload result and a main callback.');
      continue;
    }
    const wrapperSignature = checker.getSignatureFromDeclaration(wrapper)!;
    const callbackSignature = checker.getSignatureFromDeclaration(callback)!;
    const declared = checker.getAwaitedType(checker.getReturnTypeOfSignature(wrapperSignature));
    const actual = checker.getAwaitedType(checker.getReturnTypeOfSignature(callbackSignature));
    if (!declared || !actual || !checker.isTypeAssignableTo(actual, declared)) {
      failures.push(name + ' resolves to ' + (actual && checker.typeToString(actual))
        + ', expected ' + (declared && checker.typeToString(declared)) + '.');
    }
  }
  expect(failures).toEqual([]);
}, 15_000);
