import { createScriptMeta, createSession, ITestKoaServer } from '@ulixee/hero-testing/helpers';
import { Helpers } from '@ulixee/hero-testing';
import { LoadStatus } from '@ulixee/hero-interfaces/Location';
import Core from '@ulixee/hero-core';
import PageStateGenerator from '../lib/PageStateGenerator';
import PageStateAssertions from '../lib/PageStateAssertions';
import * as Fs from 'fs';
import * as Path from 'path';
import PageStateCodeBlock from '../lib/PageStateCodeBlock';
import Resolvable from '@ulixee/commons/lib/Resolvable';

let koaServer: ITestKoaServer;
beforeAll(async () => {
  await Core.start();
  koaServer = await Helpers.runKoaServer(true);
});
afterAll(Helpers.afterAll);
afterEach(Helpers.afterEach);

describe('pageStateGenerator', () => {
  test('extracts common asserts only from the given time range', async () => {
    koaServer.get('/pageStateGeneratorRange1', ctx => {
      ctx.body = `
  <body>
    <h1>Title 1</h1>
    <div id="div1">This is page 1</div>
    <ul>
      <li class="li">1</li>
    </ul>
    <script>
    window.add = function () {
      const li = document.createElement('li');
      li.classList.add('li');
      li.textContent = 'add';
      document.querySelector('ul').append(li);
    }
    </script>
  </body>
      `;
    });

    const pageStateGenerator = new PageStateGenerator('1');
    async function run() {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2e3));
      const { tab, session } = await createSession();
      await tab.goto(`${koaServer.baseUrl}/pageStateGeneratorRange1`);
      await tab.waitForLoad(LoadStatus.PaintingStable);
      await tab.flushDomChanges();
      const startTime = Date.now();
      await tab.getJsValue(`add()`);
      await tab.getJsValue(`add()`);
      await session.close();
      pageStateGenerator.addSession(session.db, tab.id, [startTime, Date.now()]);
      pageStateGenerator.addState('1', session.id);
    }
    await Promise.all([run(), run(), run()]);

    await pageStateGenerator.evaluate();
    const state = pageStateGenerator.statesByName.get('1');
    expect(state).toBeTruthy();
    expect(state.sessionIds.size).toBe(3);
    expect(Object.keys(state.assertsByFrameId)).toHaveLength(1);
    const asserts = Object.values(state.assertsByFrameId[1]);
    expect(
      asserts.filter(x => {
        return (
          x.args[0].includes('TITLE') || x.args[0].includes('DIV') || x.args[0].endsWith('/UL)')
        );
      }),
    ).toHaveLength(0);

    expect(asserts.find(x => x.args[0] === 'count(/HTML/BODY/UL/LI)').result).toBe(3);
  }, 20e3);

  test('can find differences between two pages', async () => {
    koaServer.get('/pageStateGenerator1', ctx => {
      ctx.body = `
  <body>
    <h1>Title 1</h1>
    <div id="div1">This is page 1</div>
    <ul>
      <li class="li">1</li>
      <li class="li">2</li>
      <li class="li">3</li>
    </ul>

    <script>
    window.add = function () {
      const li = document.createElement('li');
      li.classList.add('li');
      li.textContent = 'add';
      document.querySelector('ul').append(li);
    }
    </script>
  </body>
      `;
    });
    koaServer.get('/pageStateGenerator2', ctx => {
      ctx.body = `
  <body>
    <h1>Title 2</h1>
    <div id="div2">This is page 2</div>
    <ul></ul>

    <script>
    window.add = function () {
      const li = document.createElement('li');
      li.classList.add('li');
      li.textContent = 'add';
      document.querySelector('ul').append(li);
    }
    </script>
  </body>
      `;
    });

    const pageStateGenerator = new PageStateGenerator('id');
    async function run(path: string, state: string) {
      // just give some time randomization
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2e3));
      const { tab, session } = await createSession();
      await tab.goto(`${koaServer.baseUrl}/${path}`);
      await tab.waitForLoad(LoadStatus.PaintingStable);
      await tab.flushDomChanges();
      const startTime = Date.now();
      await tab.getJsValue(`add()`);
      if (state === '1') await tab.getJsValue(`add()`);
      await session.close();
      pageStateGenerator.addSession(session.db, tab.id, [startTime, Date.now()]);
      pageStateGenerator.addState(state, session.id);
    }

    await Promise.all([
      run('pageStateGenerator1', '1'),
      run('pageStateGenerator1', '1'),
      run('pageStateGenerator2', '2'),
      run('pageStateGenerator2', '2'),
    ]);

    await pageStateGenerator.evaluate();

    const states1 = pageStateGenerator.statesByName.get('1').assertsByFrameId[1];
    const states2 = pageStateGenerator.statesByName.get('2').assertsByFrameId[1];
    expect(states1).not.toEqual(states2);

    const liKey = PageStateAssertions.generateKey('xpath', ['count(/HTML/BODY/UL/LI)']);
    // add 2 to 3 existing
    expect(states1[liKey].result).toBe(5);
    // add 1 to non-existent
    expect(states2[liKey].result).toBe(1);
  }, 20e3);

  test('can diff pages based on removed elements', async () => {
    koaServer.get('/pageStateRemove', ctx => {
      ctx.body = `
  <body>
    <h1>Remove Page</h1>
    <ul>
      <li class="li">1</li>
      <li class="li">2</li>
      <li class="li">3</li>
    </ul>

    <script>
    window.remove = function () {
      document.querySelector('li').remove()
    }
    </script>
  </body>
      `;
    });

    const pageStateGenerator = new PageStateGenerator('id');
    async function run(state: string) {
      // just give some time randomization
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2e3));
      const { tab, session } = await createSession();
      await tab.goto(`${koaServer.baseUrl}/pageStateRemove`);
      await tab.waitForLoad(LoadStatus.PaintingStable);
      await tab.flushDomChanges();
      const startTime = Date.now();
      await tab.getJsValue(`remove()`);
      if (state === '1') await tab.getJsValue(`remove()`);
      await session.close();
      pageStateGenerator.addSession(session.db, tab.id, [startTime, Date.now()]);
      pageStateGenerator.addState(state, session.id);
    }

    await Promise.all([run('1'), run('1'), run('2'), run('2')]);

    await pageStateGenerator.evaluate();

    const states1 = pageStateGenerator.statesByName.get('1').assertsByFrameId[1];
    const states2 = pageStateGenerator.statesByName.get('2').assertsByFrameId[1];
    expect(states1).not.toEqual(states2);

    const liKey = PageStateAssertions.generateKey('xpath', ['count(/HTML/BODY/UL/LI)']);

    expect(states1[liKey].result).toBe(1);
    expect(states2[liKey].result).toBe(2);
  }, 20e3);

  test('can find attribute changes', async () => {
    koaServer.get('/pageStateAttr', ctx => {
      ctx.body = `
  <body>
    <h1>Attributes Page</h1>
    <div class="slider" style="width:0;">&nbsp;</div>

    <script>
    window.tick = function (pct) {
      document.querySelector('.slider').style.width = pct + '%';
    }
    </script>
  </body>
      `;
    });

    const pageStateGenerator = new PageStateGenerator('id');
    async function run(state: string) {
      // just give some time randomization
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2e3));
      const { tab, session } = await createSession();
      await tab.goto(`${koaServer.baseUrl}/pageStateAttr`);
      await tab.waitForLoad(LoadStatus.PaintingStable);
      await tab.flushDomChanges();
      const startTime = Date.now();
      if (state === '100') await tab.getJsValue(`tick(100)`);
      else await tab.getJsValue(`tick(50)`);
      await session.close();
      pageStateGenerator.addSession(session.db, tab.id, [startTime, Date.now()]);
      pageStateGenerator.addState(state, session.id);
    }

    await Promise.all([run('100'), run('100'), run('50'), run('50')]);

    await pageStateGenerator.evaluate();

    const states100 = pageStateGenerator.statesByName.get('100').assertsByFrameId[1];
    const states50 = pageStateGenerator.statesByName.get('50').assertsByFrameId[1];
    expect(states100).not.toEqual(states50);

    const sliderKey50 = PageStateAssertions.generateKey('xpath', [
      'count(/HTML/BODY/DIV[@class="slider"][@style="width: 50%;"])',
    ]);
    const sliderKey100 = PageStateAssertions.generateKey('xpath', [
      'count(/HTML/BODY/DIV[@class="slider"][@style="width: 100%;"])',
    ]);
    expect(states100[sliderKey100].result).toBe(1);
    expect(states50[sliderKey50].result).toBe(1);
  }, 20e3);

  test('can track storage changes', async () => {
    koaServer.get('/storage', ctx => {
      ctx.set('set-cookie', 'test=' + ctx.query.state);
      ctx.body = `
  <body>
    <h1>Storage Page</h1>

    <script>
    window.storage = function (state) {
      if (state === '1') {
        const openDBRequest = indexedDB.open('db1', 1);
        openDBRequest.onupgradeneeded = function(ev) {
          const db = ev.target.result;
          const store1 = db.createObjectStore('store1', {
            keyPath: 'id',
            autoIncrement: false
          });
          store1.transaction.oncomplete = function() {
            const insertStore = db
              .transaction('store1', 'readwrite')
              .objectStore('store1');
            insertStore.add({ id: 1, child: { name: 'Richard', age: new Date() }});
            insertStore.add({ id: 2, child: { name: 'Jill' } });
            insertStore.transaction.oncomplete = () => {
              document.body.classList.add('db-ready');
            }
          };
        }
      } else {
        localStorage.setItem('test', '1');
        localStorage.setItem('test2', '2');
        localStorage.removeItem('test2');
        document.body.classList.add('db-ready');
      }
    }
    </script>
  </body>
      `;
    });

    const pageStateGenerator = new PageStateGenerator('id');
    async function run(state: string) {
      // just give some time randomization
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2e3));
      const { tab, session } = await createSession();
      const startTime = Date.now();
      await tab.goto(`${koaServer.baseUrl}/storage?state=${state}`);
      await tab.waitForLoad(LoadStatus.PaintingStable);
      await tab.getJsValue(`storage('${state}')`);
      await tab.waitForElement(['document', ['querySelector', '.db-ready']]);
      await tab.flushDomChanges();
      await session.close();

      pageStateGenerator.addSession(session.db, tab.id, [startTime, Date.now()]);
      pageStateGenerator.addState(state, session.id);
    }

    await Promise.all([run('1'), run('1'), run('2'), run('2')]);

    await pageStateGenerator.evaluate();

    const states1 = pageStateGenerator.statesByName.get('1').assertsByFrameId[1];
    const states2 = pageStateGenerator.statesByName.get('2').assertsByFrameId[1];
    expect(
      Object.values(states1).filter(
        x => x.args?.length && x.args[0].type === 'cookie' && x.result === '1',
      ),
    ).toHaveLength(1);
    expect(
      Object.values(states1).filter(x => x.args?.length && x.args[0].type === 'indexedDB').length,
    ).toBeGreaterThanOrEqual(1);

    expect(
      Object.values(states2).filter(x => x.args?.length && x.args[0].type === 'localStorage')
        .length,
    ).toBeGreaterThanOrEqual(1);
  }, 20e3);

  test('can handle redirects', async () => {
    let counter = 0;
    koaServer.get('/pageStateRedirect', ctx => {
      const redirectLocation =
        counter % 2 === 0 ? 'pageStateRedirectsEnd1' : 'pageStateRedirectsEnd2';

      counter += 1;
      ctx.body = `
<head><meta http-equiv = "refresh" content = "0; url = ${koaServer.baseUrl}/${redirectLocation}"</head>
<body><h1>Redirect Page</h1></body>`;
    });

    koaServer.get('/pageStateRedirectsEnd1', ctx => {
      ctx.body = `<body><h1>Page 1</h1></body>`;
    });

    koaServer.get('/pageStateRedirectsEnd2', ctx => {
      ctx.body = `<body><h1>Page 2</h1></body>`;
    });

    const pageStateGenerator = new PageStateGenerator('id');
    async function run() {
      // just give some time randomization
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2e3));
      const { tab, session } = await createSession();
      const goto = tab.goto(`${koaServer.baseUrl}/pageStateRedirect`);
      await goto;
      await tab.waitForLocation('change');

      await tab.waitForLoad(LoadStatus.HttpResponded);
      const startTime = tab.navigations.top.statusChanges.get('HttpResponded');
      const state = tab.navigations.top.finalUrl.endsWith('1') ? '1' : '2';
      await tab.waitForLoad(LoadStatus.PaintingStable);

      await session.close();
      pageStateGenerator.addSession(session.db, tab.id, [startTime, Date.now()]);
      pageStateGenerator.addState(state, session.id);
    }

    await Promise.all([run(), run(), run(), run()]);

    await pageStateGenerator.evaluate();

    const states1 = pageStateGenerator.statesByName.get('1').assertsByFrameId[1];
    const states2 = pageStateGenerator.statesByName.get('2').assertsByFrameId[1];
    expect(states1).not.toEqual(states2);
    const h1Key = PageStateAssertions.generateKey('xpath', ['string(/HTML/BODY/H1)']);
    expect(states1[h1Key]).toBeTruthy();
    expect(states2[h1Key]).toBeTruthy();
    expect(states1[h1Key].result).toBe('Page 1');
    expect(states2[h1Key].result).toBe('Page 2');
    expect(
      states1[PageStateAssertions.generateKey('xpath', ['count(//H1[text()="Page 1"])'])].result,
    ).toBe(1);
    expect(
      states2[PageStateAssertions.generateKey('xpath', ['count(//H1[text()="Page 2"])'])].result,
    ).toBe(1);
  }, 20e3);

  test('can find resources', async () => {
    koaServer.get('/pageStateResources', ctx => {
      const xhrParam = ctx.query.state;

      ctx.body = `
<body>
<h1>Resources Page</h1>
<script>
  fetch('/xhr?param=${xhrParam}')
    .then(x => x.text())
    .then(text => {
      const div = document.createElement('div');
      div.textContent = text;
      div.id="ready";
      document.body.appendChild(div)
    })
</script>
</body>`;
    });

    koaServer.get('/xhr', ctx => {
      ctx.body = `ok ${ctx.query.param}`;
    });

    const pageStateGenerator = new PageStateGenerator('id');
    async function run(state: string) {
      // just give some time randomization
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2e3));
      const { tab, session } = await createSession();
      await tab.goto(`${koaServer.baseUrl}/pageStateResources?state=${state}`);
      const startTime = Date.now();

      await tab.waitForLoad(LoadStatus.PaintingStable);
      await tab.waitForElement(['document', ['querySelector', '#ready']]);

      await session.close();
      pageStateGenerator.addSession(session.db, tab.id, [startTime, Date.now()]);
      pageStateGenerator.addState(state, session.id);
    }

    await Promise.all([run('1'), run('2'), run('1'), run('2')]);

    await pageStateGenerator.evaluate();

    const states1 = pageStateGenerator.statesByName.get('1').assertsByFrameId[1];
    const states2 = pageStateGenerator.statesByName.get('2').assertsByFrameId[1];
    expect(states1).not.toEqual(states2);

    expect(Object.values(states1).filter(x => x.type === 'resource')).toHaveLength(1);
    expect(Object.values(states2).filter(x => x.type === 'resource')).toHaveLength(1);
  }, 20e3);

  test('can export and re-import states', async () => {
    let changeTitle = false;
    koaServer.get('/restorePage1', ctx => {
      ctx.body = `<body><h1>Title 1</h1></body>`;
    });
    koaServer.get('/restorePage2', ctx => {
      if (changeTitle) {
        ctx.body = `<body><h2>Title 3</h2></body>`;
      } else {
        ctx.body = `<body><h2>Title 2</h2></body>`;
      }
    });

    async function run(page: string, pageStateGenerator: PageStateGenerator) {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2e3));
      const { tab, session } = await createSession();
      const startTime = Date.now();
      await tab.goto(`${koaServer.baseUrl}/${page}`);
      await tab.waitForLoad('PaintingStable');
      await session.close();
      pageStateGenerator.addSession(session.db, tab.id, [startTime, Date.now()]);

      const state = page.endsWith('1') ? '1' : '2';
      pageStateGenerator.addState(state, session.id);
    }

    const psg1 = new PageStateGenerator('id');

    await Promise.all([
      run('restorePage1', psg1),
      run('restorePage1', psg1),
      run('restorePage2', psg1),
      run('restorePage2', psg1),
    ]);

    await psg1.evaluate();

    const state1 = psg1.export('1');
    expect(state1).toBeTruthy();
    expect(state1.assertions.length).toBeGreaterThanOrEqual(3);
    expect(state1.sessions).toHaveLength(2);

    const state2 = psg1.export('2');
    expect(state2).toBeTruthy();
    expect(state2.assertions.length).toBeGreaterThanOrEqual(3);
    expect(state2.sessions).toHaveLength(2);

    const psg2 = new PageStateGenerator('id');
    psg2.import('1', state1);
    psg2.import('2', state2);

    changeTitle = true;
    // add sessions to the second round
    await Promise.all([run('restorePage1', psg2), run('restorePage2', psg2)]);
    await psg2.evaluate();

    const state1Round2 = psg2.export('1');
    const state2Round2 = psg2.export('2');

    expect(state1Round2.sessions).toHaveLength(3);
    expect(state2Round2.sessions).toHaveLength(3);

    expect(state1Round2.assertions).toEqual(state1.assertions);
    // should take into account the new change
    expect(state2Round2.assertions).not.toEqual(state2.assertions);
    expect(state2Round2.assertions.filter(x => x.toString().includes('Title 2'))).toHaveLength(0);
  }, 30e3);

  test('can import generated code blocks', async () => {
    koaServer.get('/restorePageCode1', ctx => {
      ctx.body = `<body><h1>Title 1</h1></body>`;
    });
    koaServer.get('/restorePageCode2', ctx => {
      ctx.body = `<body><h2>Title 2</h2></body>`;
    });

    const scriptInstanceMeta = createScriptMeta(module, 'codeBlock');
    async function run(page: string, pageStateGenerator: PageStateGenerator) {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2e3));
      const { tab, session } = await createSession({ scriptInstanceMeta });
      const startTime = Date.now();
      await tab.goto(`${koaServer.baseUrl}/${page}`);
      await tab.waitForLoad('DomContentLoaded');
      await session.close();
      pageStateGenerator.addSession(session.db, tab.id, [startTime, Date.now()]);

      const state = page.endsWith('1') ? '1' : '2';
      pageStateGenerator.addState(state, session.id);
    }

    const generator = new PageStateGenerator('id');

    await Promise.all([
      run('restorePageCode1', generator),
      run('restorePageCode1', generator),
      run('restorePageCode2', generator),
      run('restorePageCode2', generator),
    ]);

    await generator.evaluate();
    // now write to disk
    if (!Fs.existsSync(Path.join(process.cwd(), '.ulixee'))) {
      Fs.mkdirSync(Path.join(process.cwd(), '.ulixee'));
    }
    const result = await PageStateCodeBlock.generateCodeBlock(generator, scriptInstanceMeta);
    expect(result).toBeTruthy();

    const { tab } = await createSession({ scriptInstanceMeta });
    await tab.goto(`${koaServer.baseUrl}/restorePageCode1`);
    const callbackFn = jest.fn();
    const isResolved = new Resolvable<void>();
    // @ts-ignore
    const listener = await tab.addPageStateListener('[1]', {
      callsite: 'callsite',
      states: ['1', '2'],
      commands: {
        '1-Tab.assert': [
          null,
          'Tab.assert',
          [`@/pagestate/id/${generator.statesByName.get('1').id}.json`, [1]],
        ],
        '2-Tab.assert': [
          null,
          'Tab.assert',
          [`@/pagestate/id/${generator.statesByName.get('2').id}.json`, [1]],
        ],
      },
    });


    listener.on('state', status => {
      callbackFn(status);
      if (status['1-Tab.assert'] === true) {
        listener.stop();
        isResolved.resolve();
      }
    });

    await isResolved.promise;
    listener.stop();
    expect(callbackFn).toHaveBeenCalled();
  }, 30e3);
});