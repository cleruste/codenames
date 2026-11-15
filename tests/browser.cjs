'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const FIXED = 'A-2345-6789';
const OTHER = 'A-9876-5432';
const pageErrors = [];
let browser;
let server;
let url;
let acceptConfirmation = true;
let confirmations = 0;

async function group(name, test) {
    console.log(`TEST ${name}`);
    await test();
    assert.deepEqual(pageErrors, [], 'No uncaught page errors');
    console.log(`PASS ${name}`);
}

async function context(options = {}) {
    const result = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, ...options });
    result.on('page', page => {
        page.on('pageerror', error => pageErrors.push(`${page.url()}: ${error.stack || error.message}`));
        page.setDefaultTimeout(7000);
    });
    return result;
}

const card = (page, index) => page.locator(`.card[data-index="${index}"]`);
const revealed = page => page.locator('.card.revealed').count();
const words = page => page.locator('.card-word').allTextContents();
const code = page => page.locator('#game-code').textContent();
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem(Codenames.STORAGE_KEY)));
const board = page => page.evaluate(() => Codenames.generateBoard(document.querySelector('#game-code').textContent));

async function join(page, value) {
    await page.locator('#join-details').evaluate(element => { element.open = true; });
    await page.locator('#join-code').fill(value);
    await page.locator('#join-form button').click();
}

async function undoAll(page) {
    if (await page.locator('#key-toggle').isChecked()) await page.locator('#key-toggle').uncheck();
    let count = await revealed(page);
    while (count > 0) {
        await page.locator('#undo').click();
        assert.equal(await revealed(page), --count, 'Undo removes exactly one reveal');
    }
    assert.equal(await page.locator('#undo').isDisabled(), true);
}

async function pointer(page, index, type, extra = {}) {
    await card(page, index).dispatchEvent(type, {
        pointerType: 'touch', pointerId: 7, isPrimary: true, bubbles: true,
        clientX: 20, clientY: 20, ...extra
    });
}

async function touch(page, index) {
    await pointer(page, index, 'pointerdown');
    await pointer(page, index, 'pointerup');
}

async function counters(page) {
    const generated = await board(page);
    const indices = await page.locator('.card.revealed').evaluateAll(elements => elements.map(element => Number(element.dataset.index)));
    for (const color of ['red', 'blue']) {
        const expected = generated.cards.filter((entry, index) => entry.color === color && !indices.includes(index)).length;
        assert.equal(await page.locator(`#${color}-count`).textContent(), String(expected));
        assert.match(await page.locator(`#${color}-count`).getAttribute('aria-label'), /restants/);
        assert.equal(await page.locator(`#${color}-start`).isVisible(), color === generated.start);
    }
    for (const index of indices) {
        const label = await page.evaluate(color => Codenames.LABELS[color], generated.cards[index].color);
        assert.equal(await card(page, index).locator('.card-label').textContent(), label);
        assert.match(await card(page, index).getAttribute('aria-label'), /révélée/);
    }
}

async function playable(page) {
    assert.equal(await page.locator('.card').count(), 25);
    assert.equal(await revealed(page), 0);
    assert.match(await code(page), /^A-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    const generated = await board(page);
    const index = generated.cards.findIndex(entry => entry.color === 'neutral');
    await card(page, index).dblclick();
    assert.equal(await revealed(page), 1);
    await page.locator('#undo').click();
    assert.equal(await revealed(page), 0);
}

async function main() {
    const html = await fs.readFile(path.resolve(__dirname, '../index.html'));
    server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/codenames' || pathname === '/codenames/') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end(html);
        } else if (pathname === '/favicon.ico') {
            response.writeHead(204);
            response.end();
        } else {
            response.writeHead(404);
            response.end('Not found');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${server.address().port}/codenames/`;
    browser = await chromium.launch({ headless: true });
    const desktop = await context();
    const page = await desktop.newPage();
    page.on('dialog', async dialog => {
        try {
            assert.equal(dialog.type(), 'confirm');
            confirmations++;
            if (acceptConfirmation) await dialog.accept();
            else await dialog.dismiss();
        } catch (error) {
            pageErrors.push(error.message);
            await dialog.dismiss().catch(() => {});
        }
    });
    await page.goto(url);
    let generated;
    let neutrals;

    await group('fixed-code join and confirmation', async () => {
        const before = confirmations;
        await join(page, FIXED);
        assert.equal(confirmations, before + 1);
        assert.equal(await code(page), FIXED);
        assert.equal(await revealed(page), 0);
        generated = await board(page);
        neutrals = generated.cards.flatMap((entry, index) => entry.color === 'neutral' ? [index] : []);
        assert.deepEqual(await words(page), generated.cards.map(entry => entry.word));
        assert.equal(new Set(await words(page)).size, 25);
        await counters(page);
    });

    await group('single click safe; double click reveals exactly once', async () => {
        await card(page, neutrals[0]).click();
        assert.equal(await revealed(page), 0);
        await card(page, neutrals[0]).dblclick();
        assert.equal(await revealed(page), 1);
        await card(page, neutrals[0]).dispatchEvent('dblclick', { bubbles: true });
        assert.equal(await revealed(page), 1);
        assert.deepEqual((await saved(page)).history, [neutrals[0]]);
        await undoAll(page);
    });

    await group('single touch safe; double touch reveals once; different cards safe', async () => {
        await card(page, neutrals[0]).tap();
        assert.equal(await revealed(page), 0);
        await card(page, neutrals[0]).tap();
        assert.equal(await revealed(page), 1);
        await undoAll(page);
        await touch(page, neutrals[0]);
        await touch(page, neutrals[1]);
        assert.equal(await revealed(page), 0);
        await pointer(page, neutrals[1], 'pointercancel');
        await card(page, neutrals[0]).click();
        await card(page, neutrals[1]).click();
        assert.equal(await revealed(page), 0);
    });

    await group('dragged and cancelled pointer gestures cannot reveal', async () => {
        for (const kind of ['drag', 'cancel']) {
            await pointer(page, neutrals[0], 'pointercancel');
            await touch(page, neutrals[0]);
            await pointer(page, neutrals[0], 'pointerdown');
            if (kind === 'drag') {
                await pointer(page, neutrals[0], 'pointermove', { clientX: 70 });
                await pointer(page, neutrals[0], 'pointerup', { clientX: 70 });
            } else {
                await pointer(page, neutrals[0], 'pointercancel');
                await pointer(page, neutrals[0], 'pointerup');
            }
            assert.equal(await revealed(page), 0, kind);
            await touch(page, neutrals[0]);
            assert.equal(await revealed(page), 0, `${kind} clears the pending tap`);
        }
        await pointer(page, neutrals[0], 'pointercancel');
    });

    await group('keyboard, accessibility click, repeat safety and focus recovery', async () => {
        for (const key of ['Enter', 'Space', 'accessibility']) {
            const index = neutrals[0];
            await card(page, index).focus();
            for (const repeatedKey of ['Enter', ' ']) {
                await card(page, index).dispatchEvent('keydown', { key: repeatedKey, repeat: true, bubbles: true });
            }
            assert.equal(await revealed(page), 0);
            if (key === 'accessibility') await card(page, index).dispatchEvent('click', { detail: 0, bubbles: true });
            else await page.keyboard.press(key);
            assert.equal(await revealed(page), 1);
            const expectedFocus = (index + 1) % 25;
            assert.equal(await page.evaluate(() => Number(document.activeElement.dataset.index)), expectedFocus);
            await page.evaluate(() => {
                for (const key of ['Enter', ' ']) document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: true, bubbles: true }));
            });
            assert.equal(await revealed(page), 1, 'Held keys cannot reveal the newly focused card');
            await page.keyboard.press('Tab');
            assert.equal(await revealed(page), 1, 'Tab does not reveal');
            await page.locator('#undo').click();
            assert.equal(await revealed(page), 0);
            assert.equal(await card(page, index).evaluate(element => element === document.activeElement), true);
        }
    });

    await group('key mode disables cards and undo including dispatched events', async () => {
        await card(page, neutrals[0]).dblclick();
        const before = await saved(page);
        await page.locator('#key-toggle').check();
        assert.equal(await page.locator('.card:disabled').count(), 25);
        assert.equal(await page.locator('#undo').isDisabled(), true);
        assert.equal(await page.locator('#mode-badge').textContent(), 'Clé secrète');
        for (let index = 0; index < 25; index++) {
            assert.equal(await card(page, index).evaluate((element, color) => element.classList.contains(color), generated.cards[index].color), true);
            assert.notEqual(await card(page, index).locator('.card-label').textContent(), '');
        }
        for (const index of [neutrals[0], neutrals[1]]) {
            await card(page, index).dispatchEvent('dblclick', { bubbles: true });
            await card(page, index).dispatchEvent('keydown', { key: 'Enter', bubbles: true });
            await card(page, index).dispatchEvent('keydown', { key: ' ', bubbles: true });
            await card(page, index).dispatchEvent('click', { detail: 0, bubbles: true });
            await touch(page, index);
            await touch(page, index);
        }
        await page.locator('#undo').dispatchEvent('click');
        assert.deepEqual(await saved(page), before);
        assert.equal(await revealed(page), 1);
        await page.locator('#key-toggle').uncheck();
        assert.equal(await page.locator('.card.key-only').count(), 0);
        await undoAll(page);
    });

    await group('remaining counters, reveal labels and persisted refresh with key off', async () => {
        const selected = ['red', 'blue', 'neutral'].map(color => generated.cards.findIndex(entry => entry.color === color));
        for (const index of selected) {
            await card(page, index).dblclick();
            await counters(page);
        }
        const before = await saved(page);
        const originalWords = await words(page);
        await page.locator('#key-toggle').check();
        await page.reload();
        assert.equal(await code(page), FIXED);
        assert.deepEqual(await words(page), originalWords);
        assert.deepEqual(await saved(page), before);
        assert.equal(await revealed(page), 3);
        assert.equal(await page.locator('#key-toggle').isChecked(), false);
        assert.equal(await page.locator('#undo').isEnabled(), true);
        await counters(page);
        await page.locator('#undo').click();
        assert.deepEqual((await saved(page)).history, selected.slice(0, -1));
        assert.equal(await card(page, selected[2]).evaluate(element => element === document.activeElement), true);
        await undoAll(page);
    });

    await group('invalid, unsupported, denied and same-code joins preserve history', async () => {
        await card(page, neutrals[0]).dblclick();
        const before = await saved(page);
        const originalWords = await words(page);
        const count = confirmations;
        for (const value of ['', 'not a code', 'A-0000-0000', 'B-2345-6789']) {
            await join(page, value);
            assert.equal(await page.locator('#join-error').isVisible(), true);
            assert.equal(await page.locator('#join-code').getAttribute('aria-invalid'), 'true');
            assert.match(await page.locator('#join-error').textContent(), value.startsWith('B-') ? /version|prise en charge/i : /invalide/i);
            assert.deepEqual(await saved(page), before);
            assert.equal(confirmations, count);
        }
        acceptConfirmation = false;
        await join(page, OTHER);
        assert.equal(confirmations, count + 1);
        assert.deepEqual(await saved(page), before);
        await page.locator('#new-game').click();
        assert.equal(confirmations, count + 2);
        assert.deepEqual(await saved(page), before);
        acceptConfirmation = true;
        await join(page, ' a_2345.6789 ');
        assert.equal(confirmations, count + 2);
        assert.deepEqual(await saved(page), before);
        assert.deepEqual(await words(page), originalWords);
        assert.equal(await page.locator('#join-details').getAttribute('open'), null);
        await undoAll(page);
    });

    await group('independent phone shares initial board but not progress', async () => {
        await card(page, neutrals[0]).dblclick();
        const phoneContext = await context({ viewport: { width: 390, height: 844 }, isMobile: true });
        try {
            const phone = await phoneContext.newPage();
            phone.on('dialog', dialog => dialog.accept());
            await phone.goto(url);
            await join(phone, FIXED);
            assert.equal(phone.url(), page.url());
            assert.equal(await code(phone), await code(page));
            assert.deepEqual(await words(phone), await words(page));
            assert.equal(await revealed(phone), 0);
            await phone.locator('#key-toggle').check();
            await page.locator('#key-toggle').check();
            assert.deepEqual(await phone.locator('.card').evaluateAll(elements => elements.map(element => [...element.classList].filter(value => ['red', 'blue', 'neutral', 'assassin'].includes(value)))), await page.locator('.card').evaluateAll(elements => elements.map(element => [...element.classList].filter(value => ['red', 'blue', 'neutral', 'assassin'].includes(value)))));
            await phone.locator('#key-toggle').uncheck();
            await page.locator('#key-toggle').uncheck();
            await card(phone, neutrals[1]).dispatchEvent('click', { detail: 0, bubbles: true });
            assert.deepEqual((await saved(phone)).history, [neutrals[1]]);
            assert.deepEqual((await saved(page)).history, [neutrals[0]]);
            await phone.locator('#undo').click();
            assert.equal(await revealed(page), 1);
        } finally {
            await phoneContext.close();
        }
        await undoAll(page);
    });

    await group('clipboard rejection selects manual fallback and success copies exact code', async () => {
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
        await page.locator('#copy-code').click();
        await page.locator('#manual-code').waitFor({ state: 'visible' });
        assert.deepEqual(await page.locator('#manual-code').evaluate(element => ({ value: element.value, start: element.selectionStart, end: element.selectionEnd, focused: document.activeElement === element, readonly: element.readOnly })), { value: FIXED, start: 0, end: FIXED.length, focused: true, readonly: true });
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedCode = value; } } }));
        await page.locator('#copy-code').click();
        await page.waitForFunction(() => document.querySelector('#copy-code').getAttribute('aria-label') === 'Code copié');
        assert.equal(await page.evaluate(() => window.copiedCode), FIXED);
        assert.equal(await page.locator('#manual-copy').isVisible(), false);
    });

    await group('assassin ends game without assigning a loser and undo recovers', async () => {
        const assassin = generated.cards.findIndex(entry => entry.color === 'assassin');
        await card(page, assassin).dblclick();
        assert.equal(await page.locator('.card:disabled').count(), 25);
        const status = await page.locator('#game-status').textContent();
        assert.match(status, /assassin.*terminée/i);
        assert.doesNotMatch(status, /perd|défait|victoire|rouge|bleu/i);
        await card(page, neutrals[0]).dispatchEvent('dblclick', { bubbles: true });
        await card(page, neutrals[0]).dispatchEvent('click', { detail: 0, bubbles: true });
        await card(page, neutrals[0]).dispatchEvent('keydown', { key: 'Enter', bubbles: true });
        assert.equal(await revealed(page), 1);
        await page.locator('#undo').click();
        assert.equal(await page.locator('.card:enabled').count(), 25);
        assert.equal(await page.locator('#status-banner').evaluate(element => element.classList.contains('finished')), false);
        await card(page, neutrals[0]).dblclick();
        await undoAll(page);
    });

    await group('both team victories lock all cards and undo restores play', async () => {
        for (const color of ['red', 'blue']) {
            const team = generated.cards.flatMap((entry, index) => entry.color === color ? [index] : []);
            for (const index of team) await card(page, index).dblclick();
            assert.equal(await page.locator(`#${color}-count`).textContent(), '0');
            assert.match(await page.locator('#game-status').textContent(), color === 'red' ? /Victoire.*rouge/ : /Victoire.*bleue/);
            assert.equal(await page.locator('.card:disabled').count(), 25);
            await card(page, neutrals[0]).dispatchEvent('dblclick', { bubbles: true });
            assert.equal(await revealed(page), team.length);
            await page.locator('#undo').click();
            assert.equal(await page.locator(`#${color}-count`).textContent(), '1');
            assert.equal(await card(page, team[team.length - 1]).isEnabled(), true);
            assert.equal(await card(page, neutrals[0]).isEnabled(), true);
            assert.doesNotMatch(await page.locator('#game-status').textContent(), /Victoire/);
            await undoAll(page);
        }
    });

    await group('confirmed new game replaces code, clears progress and turns key off', async () => {
        await card(page, neutrals[0]).dblclick();
        await page.locator('#key-toggle').check();
        const count = confirmations;
        await page.locator('#new-game').click();
        assert.equal(confirmations, count + 1);
        assert.notEqual(await code(page), FIXED);
        assert.equal(await revealed(page), 0);
        assert.deepEqual((await saved(page)).history, []);
        assert.equal(await page.locator('#key-toggle').isChecked(), false);
        assert.equal(await page.locator('#undo').isDisabled(), true);
        await join(page, FIXED);
        assert.deepEqual(await words(page), generated.cards.map(entry => entry.word));
    });

    await group('rules dialog keyboard focus trap, Escape and return focus', async () => {
        await page.locator('#rules-button').focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('#rules-dialog').evaluate(element => element.open), true);
        assert.equal(await page.locator('#rules-dialog').evaluate(element => element.contains(document.activeElement)), true);
        for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
            await page.keyboard.press(key);
            assert.equal(await page.locator('#rules-dialog').evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body), true, `Underlying page stays inaccessible after ${key}`);
        }
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#rules-dialog').evaluate(element => element.open), false);
        assert.equal(await page.locator('#rules-button').evaluate(element => element === document.activeElement), true);
    });

    await group('responsive geometry, five columns, unclipped words and screenshots', async () => {
        const screenshotDirectory = process.env.SCREENSHOT_DIR;
        if (screenshotDirectory) await fs.mkdir(screenshotDirectory, { recursive: true });
        for (const [width, height] of [[1180, 820], [1024, 768], [768, 1024], [390, 844], [320, 740]]) {
            await page.setViewportSize({ width, height });
            await page.mouse.move(0, 0);
            await page.evaluate(() => document.fonts.ready);
            const issues = await page.evaluate(() => {
                const problems = [];
                const rect = element => element.getBoundingClientRect();
                const cards = [...document.querySelectorAll('.card')];
                if (document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1) problems.push('page overflows horizontally');
                if (getComputedStyle(document.querySelector('#board')).gridTemplateColumns.split(' ').length !== 5) problems.push('not five columns');
                const boxes = cards.map(rect);
                boxes.forEach((box, index) => {
                    if (box.height < 76 - 0.1) problems.push(`card ${index} too short: ${box.height}`);
                    if (box.left < -0.5 || box.right > innerWidth + 0.5) problems.push(`card ${index} clipped by viewport`);
                    if (Math.abs(box.top - boxes[Math.floor(index / 5) * 5].top) > 1) problems.push(`card ${index} outside its row`);
                    for (let other = 0; other < index; other++) {
                        const second = boxes[other];
                        if (Math.min(box.right, second.right) - Math.max(box.left, second.left) > 0.5 && Math.min(box.bottom, second.bottom) - Math.max(box.top, second.top) > 0.5) problems.push(`cards ${index}/${other} overlap`);
                    }
                    const word = cards[index].querySelector('.card-word');
                    const range = document.createRange();
                    range.selectNodeContents(word);
                    for (const line of range.getClientRects()) {
                        if (line.left < box.left + 0.5 || line.right > box.right - 0.5 || line.top < box.top || line.bottom > box.bottom) problems.push(`word ${index} clipped`);
                        const label = rect(cards[index].querySelector('.card-label'));
                        if (line.bottom > label.top + 0.5) problems.push(`word ${index} overlaps label`);
                    }
                    if (word.scrollWidth > word.clientWidth + 1 || word.scrollHeight > word.clientHeight + 1) problems.push(`word ${index} overflows`);
                });
                return problems;
            });
            assert.deepEqual(issues, [], `${width}x${height}`);
            if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `codenames-${width}x${height}.png`), fullPage: true });
            console.log(`  geometry ${width}x${height}`);
        }
    });

    await group('corrupted saved state reload remains playable', async () => {
        await page.evaluate(() => localStorage.setItem(Codenames.STORAGE_KEY, '{broken-json'));
        await page.reload();
        assert.equal(await page.locator('#notice').isVisible(), true);
        assert.match(await page.locator('#notice').textContent(), /illisible|sauvegarde/i);
        await playable(page);
        assert.deepEqual((await saved(page)).history, []);
    });

    await group('throwing localStorage getter remains playable in a fresh context', async () => {
        const unavailable = await context();
        try {
            await unavailable.addInitScript(() => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Unavailable', 'SecurityError'); } }));
            const isolated = await unavailable.newPage();
            await isolated.goto(url);
            assert.equal(await isolated.locator('#notice').isVisible(), true);
            assert.match(await isolated.locator('#notice').textContent(), /stockage|sauvegarde|appareil/i);
            await playable(isolated);
            await isolated.reload();
            await playable(isolated);
        } finally {
            await unavailable.close();
        }
    });
    await desktop.close();
    assert.deepEqual(pageErrors, []);
    console.log('PASS all browser validation groups; no uncaught page errors');
}

(async () => {
    try {
        await main();
    } catch (error) {
        console.error(error.stack || error);
        process.exitCode = 1;
    } finally {
        if (browser) {
            try { await browser.close(); }
            catch (error) { console.error(error); process.exitCode = 1; }
        }
        if (server) {
            try {
                await new Promise((resolve, reject) => {
                    server.close(error => error ? reject(error) : resolve());
                    if (server.closeAllConnections) server.closeAllConnections();
                });
            } catch (error) { console.error(error); process.exitCode = 1; }
        }
        if (pageErrors.length) {
            console.error('Uncaught page errors:', pageErrors);
            process.exitCode = 1;
        }
    }
})();
