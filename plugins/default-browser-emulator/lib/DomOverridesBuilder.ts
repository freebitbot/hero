import * as fs from 'fs';
import { IFrame } from '@ulixee/unblocked-specification/agent/browser/IFrame';
import TypeSerializer, { stringifiedTypeSerializerClass } from '@ulixee/commons/lib/TypeSerializer';
import INewDocumentInjectedScript from '../interfaces/INewDocumentInjectedScript';
import IBrowserEmulatorConfig, { InjectedScript } from '../interfaces/IBrowserEmulatorConfig';

const injectedSourceUrl = `<anonymous-${Math.random()}>`;
const cache: { [name: string]: string } = {};
const shouldCache = process.env.NODE_ENV === 'production';
const utilsScript = [
  fs.readFileSync(`${__dirname}/../injected-scripts/_utils.js`, 'utf8'),
].join('\n');

export { injectedSourceUrl };

export default class DomOverridesBuilder {
  private readonly scriptsByName = new Map<string, string>();
  private readonly alwaysPageScripts = new Set<INewDocumentInjectedScript>();
  private readonly alwaysWorkerScripts = new Set<INewDocumentInjectedScript>();

  private workerOverrides = new Set<string>();

  constructor(private readonly config?: IBrowserEmulatorConfig) {}

  public getWorkerOverrides(): string[] {
    return [...this.workerOverrides];
  }

  public build(
    type: 'worker' | 'service_worker' | 'shared_worker' | 'page' = 'page',
    scriptNames?: string[],
  ): {
    script: string;
    callbacks: INewDocumentInjectedScript['callback'][];
  } {
    const scripts = new Map<string, string>();
    const callbacks = [];
    for (const [name, script] of this.scriptsByName) {
      const shouldIncludeScript = scriptNames ? scriptNames.includes(name) : true;
      if (shouldIncludeScript) {
        scripts.set(name, script);
      }
    }

    if (type === 'page') {
      let counter = 0;
      for (const script of this.alwaysPageScripts) {
        if (script.callback) callbacks.push(script.callback);
        if (script.script) scripts.set(`alwaysPageScript${counter}`, script.script);
        counter += 1;
      }
    } else if (type.includes('worker')) {
      let counter = 0;
      for (const script of this.alwaysWorkerScripts) {
        if (script.callback) callbacks.push(script.callback);
        if (script.script) scripts.set(`alwaysWorkerScript${counter}`, script.script);
        counter += 1;
      }
    }

    const shouldNotRunInWorker: (name: string) => boolean = name => {
      if (name.startsWith('alwaysWorkerScript')) return false;
      return !this.workerOverrides.has(name);
    };

    const catchHandling =
      process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development'
        ? ' console.error("ERROR in dom override script", e); '
        : '';
    return {
      callbacks,
      // NOTE: don't make this async. It can cause issues if you read a frame right after creation, for instance
      script: `
(function newDocumentScriptWrapper(scopedVars = {}) {
  const exports = {};
  const targetType = '${type}';
  // Worklet has no scope to override, but we can't detect until it loads
  if (typeof self === 'undefined' && typeof window === 'undefined') return;

  if (!scopedVars.runMap) scopedVars.runMap = new WeakSet();
  const runMap = scopedVars.runMap;

  if (runMap.has(self)) return;

  let callbackHere;
  try {
      callbackHere = callback;
  } catch {
      callbackHere = (...args) => {console.log('callback not defined, currently not supported in workers')};
  }

  ${stringifiedTypeSerializerClass};
  
  const utilsInput = {
    sourceUrl: '${injectedSourceUrl}',
    targetType: '${type}',
    callback: callbackHere,
  }
  const sourceUrl = '${injectedSourceUrl}';
  ${utilsScript.replaceAll('export function', 'function')};
  const utils = main(utilsInput);

  const baseScriptInput = {...utilsInput, utils, TypeSerializer};
  
  (function newDocumentScript(selfOverride) {
    const originalSelf = self;
    if (selfOverride) self = selfOverride;

    try {
      if (runMap.has(self)) return;
      runMap.add(self);
      const isWorker = !self.document && "WorkerGlobalScope" in self;

      ${[...scripts]
        .map(([name, script]) => {
          let snippet = '';
          if (shouldNotRunInWorker(name)) snippet += `if (!isWorker) {\n`;
          snippet += `try { ${script} } catch(e) {${catchHandling}}`;
          if (shouldNotRunInWorker(name)) snippet += '\n}';
          return snippet;
        })
        .join('\n\n')};

      PathToInstanceTracker.updateAllReferences();
    } finally {
      self = originalSelf;
      utils.getSharedStorage().ready = true;
    }
  })();
})();
//# sourceURL=${injectedSourceUrl}`.replace(/\/\/# sourceMap.+/g, ''),
    };
  }

  public registerWorkerOverrides(...names: InjectedScript[]): void {
    for (const name of names) this.workerOverrides.add(name);
  }

  public add<T = undefined>(
    name: InjectedScript,
    args: T = undefined,
    registerWorkerOverride = false,
  ): void {
    let script = cache[name];
    if (!script) {
      if (!fs.existsSync(`${__dirname}/../injected-scripts/${name}.js`)) {
        throw new Error(`Browser-Emulator injected script doesn\`t exist: ${name}`);
      }
      script = fs.readFileSync(`${__dirname}/../injected-scripts/${name}.js`, 'utf8');
    }
    if (shouldCache) cache[name] = script;

    script = script
      .replaceAll('export function', 'function')
      .split('\n')
      .filter(line => !line.includes('export {'))
      .join('\n');

    let wrapper = this.wrapScript(name, script, args);

    if (name.startsWith('polyfill.')) {
      wrapper = `// if main frame and HTML element not loaded yet, give it a sec
  if (!document.documentElement) {
    new MutationObserver((list, observer) => {
      observer.disconnect();
      ${wrapper};
    }).observe(document, {childList: true, subtree: true});
  } else {
    ${wrapper};
  }

`;
    }
    this.scriptsByName.set(name, wrapper);
    if (registerWorkerOverride) {
      this.registerWorkerOverrides(name);
    }
  }

  public addPageScript(
    script: string,
    args: Record<string, any> & { callbackName?: string },
    callbackFn?: (data: string, frame: IFrame) => any,
  ): void {
    args ??= {};
    args.callbackName ??= `injectedCallback${this.alwaysPageScripts.size}`;
    const wrapped = this.wrapScript('customScript', script, args);
    this.alwaysPageScripts.add({
      script: wrapped,
      callback: {
        name: args.callbackName,
        fn: callbackFn,
      },
    });
  }

  public addOverrideAndUseConfig<T extends InjectedScript>(
    injectedScript: T,
    defaultConfig: IBrowserEmulatorConfig[T],
    opts?: { registerWorkerOverride?: boolean },
  ): void {
    if (!this.config)
      throw new Error(
        'This method can only be used when creating domOverriderBuilder with a config',
      );

    const scriptConfig = this.config[injectedScript];
    if (!scriptConfig) return;

    this.add<IBrowserEmulatorConfig[T]>(
      injectedScript,
      scriptConfig === true ? defaultConfig : scriptConfig,
      opts?.registerWorkerOverride ?? false,
    );
  }

  public cleanup(): void {
    this.alwaysPageScripts.clear();
    this.alwaysWorkerScripts.clear();
  }

  public addWorkerScript(script: string, args: any = {}): void {
    const wrapped = this.wrapScript('customScript', script, args);
    this.alwaysWorkerScripts.add({
      script: wrapped,
    });
  }

  private wrapScript(name: string, script: string, args: any = {}): string {
    const serialized = TypeSerializer.stringify(args);
    // JSON.stringify needed in script to make sure everything is escape correctly
    // as sending this over CDP already reverses some logic
    return `
try{
  (function newDocumentScript_${name.replace(/\./g, '__')}(args) {
    try {
      ${script};
      main({...baseScriptInput, args});
    } catch(err) {
      console.log('Failed to initialize "${name}"', err);
    }
  })(TypeSerializer.parse(JSON.stringify(${serialized})));
  } catch (error){
    console.log(error)
  }`;
  }
}

export function getOverrideScript(
  name: InjectedScript,
  args?: any,
): { script: string; callbacks: INewDocumentInjectedScript['callback'][] } {
  const injected = new DomOverridesBuilder();
  injected.add(name, args);
  return injected.build('page');
}
