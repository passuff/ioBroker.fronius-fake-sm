'use strict';

const assert = require('assert');
const { candidateHosts, advertisedListenIps } = require('../lib/froniusDiscover');

const hosts = candidateHosts(64);
assert.ok(Array.isArray(hosts), 'hosts array');
// May be empty on some CI hosts without non-internal IPv4; still must not throw
assert.ok(hosts.length === 0 || /^\d+\.\d+\.\d+\.\d+$/.test(hosts[0]));

const ips = advertisedListenIps();
assert.ok(Array.isArray(ips));

console.log('froniusDiscover.test.js OK', { hostCandidates: hosts.length, listenIps: ips.length });
