/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { join, normalize, virtualFs } from '@angular-devkit/core';
import { tap } from 'rxjs/operators';
import { Timeout, host, runTargetSpec } from '../utils';


describe('Server Builder', () => {
  const outputPath = normalize('dist-server');

  beforeEach(done => host.initialize().toPromise().then(done, done.fail));
  afterEach(done => host.restore().toPromise().then(done, done.fail));

  it('works (base)', (done) => {
    const overrides = { };

    runTargetSpec(host, { project: 'app', target: 'server' }, overrides).pipe(
      tap((buildEvent) => {
        expect(buildEvent.success).toBe(true);

        const fileName = join(outputPath, 'main.js');
        const content = virtualFs.fileBufferToString(host.scopedSync().read(normalize(fileName)));
        expect(content).toMatch(/AppServerModuleNgFactory/);
      }),
    ).toPromise().then(done, done.fail);
  }, Timeout.Standard);

  it('supports sourcemaps', (done) => {
    const overrides = { sourceMap: true };

    runTargetSpec(host, { project: 'app', target: 'server' }, overrides).pipe(
      tap((buildEvent) => {
        expect(buildEvent.success).toBe(true);

        const fileName = join(outputPath, 'main.js');
        const content = virtualFs.fileBufferToString(host.scopedSync().read(normalize(fileName)));
        expect(content).toMatch(/AppServerModuleNgFactory/);
        expect(host.scopedSync().exists(join(outputPath, 'main.js.map'))).toBeTruthy();
      }),
    ).toPromise().then(done, done.fail);
  }, Timeout.Standard);

  it('runs watch mode', (done) => {
    const overrides = { watch: true };

    runTargetSpec(host, { project: 'app', target: 'server' }, overrides).pipe(
      tap((buildEvent) => {
        expect(buildEvent.success).toBe(true);

        const fileName = join(outputPath, 'main.js');
        const content = virtualFs.fileBufferToString(host.scopedSync().read(normalize(fileName)));
        expect(content).toMatch(/AppServerModuleNgFactory/);
      }),
    ).subscribe(undefined, done.fail, done);
  }, Timeout.Standard);
});
