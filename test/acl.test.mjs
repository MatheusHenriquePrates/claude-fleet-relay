import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNetworkByToken, checkAcl } from '../src/acl.mjs';

const networks = {
  team: {
    name: 'team',
    mode: 'bidirectional',
    token: 'tok-team',
    members: {
      alpha: { namespace: 'ns-a' },
      beta:  { namespace: 'ns-b' },
    },
    initiators: [],
  },
  'admin-to-workers': {
    name: 'admin-to-workers',
    mode: 'unidirectional',
    token: 'tok-admin',
    initiators: ['admin'],
    members: {
      admin: { namespace: 'ns-admin' },
      worker: { namespace: 'ns-worker' },
    },
  },
};

test('findNetworkByToken returns matching network', () => {
  const n = findNetworkByToken(networks, 'tok-team');
  assert.equal(n.name, 'team');
});

test('findNetworkByToken returns null for unknown', () => {
  assert.equal(findNetworkByToken(networks, 'bogus'), null);
  assert.equal(findNetworkByToken(networks, ''), null);
  assert.equal(findNetworkByToken(networks, null), null);
});

test('bidirectional allows either direction', () => {
  const n = findNetworkByToken(networks, 'tok-team');
  assert.equal(checkAcl(n, 'alpha', 'beta').ok, true);
  assert.equal(checkAcl(n, 'beta', 'alpha').ok, true);
});

test('bidirectional rejects self-call', () => {
  const n = findNetworkByToken(networks, 'tok-team');
  const r = checkAcl(n, 'alpha', 'alpha');
  assert.equal(r.ok, false);
  assert.match(r.reason, /self-call/);
});

test('bidirectional rejects non-member', () => {
  const n = findNetworkByToken(networks, 'tok-team');
  const r = checkAcl(n, 'alpha', 'gamma');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a member/);
});

test('unidirectional allows initiator -> recipient', () => {
  const n = findNetworkByToken(networks, 'tok-admin');
  assert.equal(checkAcl(n, 'admin', 'worker').ok, true);
});

test('unidirectional rejects recipient -> initiator', () => {
  const n = findNetworkByToken(networks, 'tok-admin');
  const r = checkAcl(n, 'worker', 'admin');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not an initiator/);
});
