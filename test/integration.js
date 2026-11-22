'use strict';

const path = require('path');
const { tests } = require('@iobroker/testing');

// Adapter must start with default settings against a real JS-Controller.
tests.integration(path.join(__dirname, '..'));
