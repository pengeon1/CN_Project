import { describe, expect, it } from 'vitest';
import React from 'react';
import App from '../src/App.js';

describe('Client renderer smoke test', () => {
  it('instantiates the App component successfully', () => {
    const element = React.createElement(App);
    expect(element).toBeDefined();
    expect(element.type).toBe(App);
  });
});
