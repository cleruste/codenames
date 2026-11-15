'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => !/\bsrc\s*=/i.test(match[1]));
const core = scripts.find(match => /\bid\s*=\s*["']game-core["']/i.test(match[1]));
assert.ok(core, 'The inline game-core script must exist');
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code = 'A-2345-6789';

function instance(source = core[2], globals = {}) {
    const context = vm.createContext({ crypto: webcrypto, ...globals });
    vm.runInContext(source, context, { filename: 'index.html:game-core', timeout: 1000 });
    return vm.runInContext('Codenames', context, { timeout: 1000 });
}

const game = instance();

function indices(state, color) {
    return clone(state.cards).flatMap((card, index) => card.color === color ? [index] : []);
}

function memoryStorage(initial = null) {
    let value = initial;
    return {
        getItem(key) {
            assert.equal(key, game.STORAGE_KEY);
            return value;
        },
        setItem(key, next) {
            assert.equal(key, game.STORAGE_KEY);
            assert.equal(typeof next, 'string');
            value = next;
        }
    };
}

function saved(overrides = {}) {
    return JSON.stringify({ schema: 1, code, revealed: [], history: [], ...overrides });
}

test('every embedded JavaScript script parses', () => {
    assert.ok(scripts.length >= 2);
    scripts.forEach((match, index) => {
        assert.doesNotThrow(() => new vm.Script(match[2], { filename: `inline-${index}.js` }));
    });
});

test('static deployment disables Jekyll without configuring a custom domain', () => {
    assert.ok(fs.statSync(path.join(root, '.nojekyll')).isFile());
    assert.equal(fs.existsSync(path.join(root, 'CNAME')), false);
});

test('version A dictionary has 794 unique frozen words in the original exact order', () => {
    assert.equal(game.WORDS_A.length, 794);
    assert.equal(new Set(game.WORDS_A).size, 794);
    assert.ok(game.WORDS_A.every(word => typeof word === 'string' && word.length > 0));
    assert.equal(Object.isFrozen(game.WORDS_A), true);
    assert.throws(() => { game.WORDS_A[0] = 'CHANGED'; }, /read only|readonly|Cannot assign/i);
    assert.throws(() => game.WORDS_A.push('CHANGED'), /extensible|read only|readonly/i);
    assert.equal(digest(game.WORDS_A), '717dcd93254ad3f8bb012dc30641a0155b7ceb87dfc3e0a6ed26c95244258317');
});

for (const [input, expected] of Object.entries({
    'A-2345-6789': '0d094abc167b6d983c65ee6cae8236b91e99310fe01b37244186877f7a1eea57',
    'A-ZZZZ-ZZZZ': '375b991c159e61d6fd56755dcae1c6053718534e438ce60b58550303ce218099',
    'A-AAAA-AAAA': '6b66bdfa1c0701b46e08fa901a15c59ac2cd0b97cc3e2c7a0ed508639d7d192c'
})) {
    test(`board compatibility fixture ${input}`, () => {
        assert.equal(digest(game.generateBoard(input)), expected);
    });
}

test('1000 deterministic boards have unique words, valid counts, and both starting teams', () => {
    const starts = new Set();
    const boards = new Set();
    for (let seed = 0; seed < 1000; seed++) {
        let value = seed;
        const encoded = Array.from({ length: 8 }, () => {
            const char = game.ALPHABET[value % game.ALPHABET.length];
            value = Math.floor(value / game.ALPHABET.length);
            return char;
        }).join('');
        const input = `A-${encoded.slice(0, 4)}-${encoded.slice(4)}`;
        const board = game.generateBoard(input);
        assert.equal(board.code, input);
        assert.deepEqual(clone(board), clone(game.generateBoard(input)));
        assert.equal(board.cards.length, 25);
        assert.equal(new Set(board.cards.map(card => card.word)).size, 25);
        assert.ok(board.cards.every(card => game.WORDS_A.includes(card.word)));
        const counts = { red: 0, blue: 0, neutral: 0, assassin: 0 };
        for (const card of board.cards) {
            assert.ok(Object.hasOwn(counts, card.color));
            counts[card.color]++;
        }
        assert.ok(board.start === 'red' || board.start === 'blue');
        assert.equal(counts[board.start], 9);
        assert.equal(counts[board.start === 'red' ? 'blue' : 'red'], 8);
        assert.equal(counts.neutral, 7);
        assert.equal(counts.assassin, 1);
        starts.add(board.start);
        boards.add(JSON.stringify(board.cards));
    }
    assert.deepEqual([...starts].sort(), ['blue', 'red']);
    assert.equal(boards.size, 1000);
});

test('independent VM instances reconstruct identical boards regardless of prior calls', () => {
    const first = instance();
    const second = instance();
    for (const input of [code, 'A-ZZZZ-ZZZZ', 'A-AAAA-AAAA']) {
        first.generateBoard('A-9999-9999');
        second.createCode();
        assert.deepEqual(clone(first.generateBoard(input)), clone(second.generateBoard(input)));
    }
    assert.notEqual(first.WORDS_A, second.WORDS_A);
});

test('codes normalize lowercase, whitespace, and supported separators', () => {
    for (const input of ['a23456789', ' a-2345-6789 ', 'a 2345 6789', 'a_2345.6789', 'a–2345—6789', '\ta - 23 45_67.89\n']) {
        assert.equal(game.normalizeCode(input), code);
        assert.deepEqual(clone(game.generateBoard(input)), clone(game.generateBoard(code)));
    }
});

test('invalid characters, lengths, types, and unsupported versions are rejected', () => {
    for (const input of [null, undefined, 123456789, {}, [], '', 'A-2345-678', 'A-2345-67899', 'A-0234-5678', 'A-1234-5678', 'A-I234-5678', 'A-O234-5678', 'A-2345/6789', 'A-2345-678!']) {
        assert.throws(() => game.normalizeCode(input));
        assert.throws(() => game.generateBoard(input));
        assert.throws(() => game.newState(input));
    }
    for (const input of ['B-2345-6789', 'Z-AAAA-AAAA']) {
        assert.throws(() => game.normalizeCode(input), /Version/);
        assert.throws(() => game.generateBoard(input), /Version/);
    }
});

test('code creation uses eight cryptographic bytes, masks them, and never uses Math.random', () => {
    const safeMath = Object.create(Math);
    safeMath.random = () => { throw new Error('Math.random must not be called'); };
    let calls = 0;
    const crypto = {
        getRandomValues(bytes) {
            calls++;
            assert.equal(Object.prototype.toString.call(bytes), '[object Uint8Array]');
            assert.equal(bytes.length, 8);
            bytes.set([0, 1, 2, 3, 28, 29, 30, 255]);
            return bytes;
        }
    };
    const local = instance(core[2], { Math: safeMath, crypto });
    assert.equal(local.createCode(), 'A-2345-WXYZ');
    assert.equal(calls, 1);
    assert.equal(local.createCode(crypto), 'A-2345-WXYZ');
    assert.equal(calls, 2);
    assert.equal(local.generateBoard(code).cards.length, 25);
    for (const input of [null, {}, { getRandomValues: true }]) assert.throws(() => local.createCode(input));
    assert.throws(() => instance(core[2], { crypto: undefined }).createCode(), /sécurisée|indisponible/);
    assert.throws(() => local.createCode({ getRandomValues() { throw new Error('blocked crypto'); } }), /blocked crypto/);
    for (let i = 0; i < 20; i++) assert.match(game.createCode(), /^A-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
});

test('word and color shuffles use independent domain-separated random streams', () => {
    const board = game.generateBoard(code);
    const wordsRandom = game.stream(game.hash(`codenames:A:words:${code}`));
    const colorsRandom = game.stream(game.hash(`codenames:A:colors:${code}`));
    const start = colorsRandom() < 0.5 ? 'red' : 'blue';
    const colors = game.shuffle([
        ...Array(9).fill(start),
        ...Array(8).fill(start === 'red' ? 'blue' : 'red'),
        ...Array(7).fill('neutral'),
        'assassin'
    ], colorsRandom);
    assert.equal(board.start, start);
    assert.deepEqual(clone(board.cards.map(card => card.word)), clone(game.shuffle(game.WORDS_A, wordsRandom).slice(0, 25)));
    assert.deepEqual(clone(board.cards.map(card => card.color)), clone(colors));
    const alteredSource = core[2].replace('shuffle(WORDS_A, wordsRandom)', 'shuffle(WORDS_A.slice(1), wordsRandom)');
    assert.notEqual(alteredSource, core[2]);
    const alteredBoard = instance(alteredSource).generateBoard(code);
    assert.equal(alteredBoard.start, board.start);
    assert.deepEqual(clone(alteredBoard.cards.map(card => card.color)), clone(board.cards.map(card => card.color)));
    assert.notDeepEqual(clone(alteredBoard.cards.map(card => card.word)), clone(board.cards.map(card => card.word)));
    const input = [1, 2, 3, 4];
    assert.deepEqual(clone(game.shuffle(input, () => 0)), [2, 3, 4, 1]);
    assert.deepEqual(input, [1, 2, 3, 4]);
});

test('reveals are immutable, idempotent, and validate indices', () => {
    const state = game.newState(code);
    const snapshot = clone(state);
    assert.deepEqual(clone(state.revealed), []);
    assert.deepEqual(clone(state.history), []);
    assert.equal(state.keyMode, false);
    assert.equal(game.outcome(state), null);
    const index = indices(state, 'neutral')[0];
    Object.freeze(state.revealed);
    Object.freeze(state.history);
    Object.freeze(state.cards);
    Object.freeze(state);
    const next = game.reveal(state, index);
    assert.notEqual(next, state);
    assert.deepEqual(clone(state), snapshot);
    assert.deepEqual(clone(next.revealed), [index]);
    assert.deepEqual(clone(next.history), [index]);
    assert.equal(next.cards, state.cards);
    assert.equal(game.reveal(next, index), next);
    for (const invalid of [-1, 25, 100, 0.5, NaN, Infinity, -Infinity, '0', null, undefined, {}, []]) {
        assert.equal(game.reveal(state, invalid), state);
    }
    const edge = game.newState(code);
    assert.deepEqual(clone(game.reveal(edge, 0).revealed), [0]);
    assert.deepEqual(clone(game.reveal(edge, 24).revealed), [24]);
});

test('undo removes only the latest choice and preserves every card position', () => {
    const initial = game.newState(code);
    assert.equal(game.undo(initial), initial);
    const choices = indices(initial, 'neutral').slice(0, 3).reverse();
    const first = game.reveal(initial, choices[0]);
    const second = game.reveal(first, choices[1]);
    const third = game.reveal(second, choices[2]);
    const before = clone(third);
    const undone = game.undo(third);
    assert.deepEqual(clone(third), before);
    assert.deepEqual(clone(undone), clone(second));
    assert.equal(undone.cards, initial.cards);
    assert.deepEqual(clone(undone.cards), clone(initial.cards));
    assert.deepEqual(clone(game.undo(game.undo(undone))), clone(initial));
    assert.deepEqual(clone(game.reveal(undone, choices[2])), clone(third));
});

test('key mode protects both reveal and undo without changing state', () => {
    const initial = game.newState(code);
    const [first, second] = indices(initial, 'neutral');
    const played = game.reveal(initial, first);
    const protectedState = { ...played, keyMode: true };
    const before = clone(protectedState);
    assert.equal(game.reveal(protectedState, second), protectedState);
    assert.equal(game.undo(protectedState), protectedState);
    assert.deepEqual(clone(protectedState), before);
    const unlocked = { ...protectedState, keyMode: false };
    assert.notEqual(game.reveal(unlocked, second), unlocked);
    assert.deepEqual(clone(game.undo(unlocked)), clone(initial));
});

for (const color of ['red', 'blue']) {
    test(`${color} wins without tracked turns and undo recovers from victory`, () => {
        let state = game.newState(code);
        const other = color === 'red' ? 'blue' : 'red';
        const targets = indices(state, color);
        const untouched = game.remaining(state, other);
        for (let i = 0; i < targets.length; i++) {
            assert.equal(game.outcome(state), null);
            state = game.reveal(state, targets[i]);
            assert.equal(game.remaining(state, color), targets.length - i - 1);
            assert.equal(game.remaining(state, other), untouched);
        }
        assert.equal(game.outcome(state), color);
        assert.equal(Object.hasOwn(state, 'turn'), false);
        assert.equal(Object.hasOwn(state, 'currentTeam'), false);
        assert.equal(Object.hasOwn(state, 'loser'), false);
        assert.equal(game.reveal(state, indices(state, 'neutral')[0]), state);
        const recovered = game.undo(state);
        assert.equal(game.outcome(recovered), null);
        assert.equal(game.remaining(recovered, color), 1);
        assert.equal(game.outcome(game.reveal(recovered, targets.at(-1))), color);
        assert.deepEqual(clone(game.restore(game.serialize(state))), clone(state));
    });
}

test('assassin ends the game without attributing a loser and undo allows recovery', () => {
    let state = game.newState(code);
    const [first, second] = indices(state, 'neutral');
    state = game.reveal(state, first);
    const assassin = indices(state, 'assassin')[0];
    const terminal = game.reveal(state, assassin);
    assert.equal(game.outcome(terminal), 'assassin');
    assert.equal(Object.hasOwn(terminal, 'loser'), false);
    assert.equal(Object.hasOwn(terminal, 'winner'), false);
    for (let i = 0; i < 25; i++) assert.equal(game.reveal(terminal, i), terminal);
    const recovered = game.undo(terminal);
    assert.deepEqual(clone(recovered), clone(state));
    assert.equal(game.outcome(recovered), null);
    assert.notEqual(game.reveal(recovered, second), recovered);
    assert.deepEqual(clone(game.restore(game.serialize(terminal))), clone(terminal));
});

test('persistence roundtrips reveals and history while always restoring key mode off', () => {
    const initial = game.newState(code);
    const choices = indices(initial, 'neutral').slice(0, 3).reverse();
    const played = choices.reduce((state, index) => game.reveal(state, index), initial);
    const protectedState = { ...played, keyMode: true };
    const raw = game.serialize(protectedState);
    assert.deepEqual(JSON.parse(raw), { schema: 1, code, revealed: choices, history: choices });
    assert.deepEqual(clone(game.restore(raw)), clone(played));
    assert.equal(game.restore(JSON.stringify({ ...JSON.parse(raw), keyMode: true })).keyMode, false);
    const storage = memoryStorage();
    assert.deepEqual(clone(game.load(storage)), { state: null, issue: null });
    assert.equal(game.save(storage, protectedState), true);
    assert.deepEqual(clone(game.load(storage)), { state: clone(played), issue: null });
    const undone = game.undo(game.load(storage).state);
    assert.deepEqual(clone(undone.history), choices.slice(0, -1));
    assert.deepEqual(clone(undone.cards), clone(initial.cards));
});

test('corrupt saves reject malformed data, duplicate indices, and invalid histories', () => {
    const invalid = [
        '', '{', 'undefined', 'null', '[]', 'true', '42', '{}',
        saved({ schema: 2 }), saved({ schema: '1' }), saved({ code: 'B-2345-6789' }),
        saved({ code: null }), saved({ revealed: null }), saved({ history: {} }),
        saved({ revealed: [0], history: [] }), saved({ revealed: [], history: [0] }),
        saved({ revealed: [0, 0], history: [0, 0] }),
        saved({ revealed: [0, 1], history: [0, 0] }),
        saved({ revealed: [0], history: [1] }),
        saved({ revealed: Array(26).fill(0), history: Array(26).fill(0) })
    ];
    for (const index of [-1, 25, 1.5, '0', null, {}, []]) {
        invalid.push(saved({ revealed: [index], history: [index] }));
        invalid.push(saved({ revealed: [0], history: [index] }));
    }
    for (const raw of invalid) {
        assert.equal(game.restore(raw), null, raw);
        assert.deepEqual(clone(game.load(memoryStorage(raw))), { state: null, issue: 'corrupt' }, raw);
    }
});

test('post-terminal histories are rejected and a clean save recovers corrupted storage', () => {
    const state = game.newState(code);
    const neutral = indices(state, 'neutral')[0];
    const assassin = indices(state, 'assassin')[0];
    const histories = [[assassin, neutral]];
    for (const color of ['red', 'blue']) histories.push([...indices(state, color), neutral]);
    for (const history of histories) {
        const raw = saved({ revealed: history, history });
        assert.equal(game.restore(raw), null);
        const storage = memoryStorage(raw);
        assert.equal(game.load(storage).issue, 'corrupt');
        assert.equal(game.save(storage, state), true);
        assert.deepEqual(clone(game.load(storage)), { state: clone(state), issue: null });
    }
});

test('blocked storage never throws during load or save', () => {
    const state = game.newState(code);
    const blocked = {
        getItem() { throw new Error('storage blocked'); },
        setItem() { throw new Error('quota exceeded'); }
    };
    const blockedAccess = Object.defineProperties({}, {
        getItem: { get() { throw new Error('getter blocked'); } },
        setItem: { get() { throw new Error('getter blocked'); } }
    });
    for (const storage of [blocked, blockedAccess, null, undefined, {}]) {
        assert.doesNotThrow(() => {
            assert.deepEqual(clone(game.load(storage)), { state: null, issue: 'unavailable' });
            assert.equal(game.save(storage, state), false);
        });
    }
});
