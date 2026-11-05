/*
 * backgroundAnalysisLifetime.test.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 */

import assert from 'assert';
import { once } from 'events';
import { CancellationToken } from 'vscode-languageserver';
import { MessagePort } from 'worker_threads';

import { BackgroundAnalysisBase, BackgroundRequest } from '../backgroundAnalysisBase';
import { serialize } from '../backgroundThreadBase';
import { OperationCanceledException } from '../common/cancellationUtils';
import { NullConsole } from '../common/console';
import { Uri } from '../common/uri/uri';

class TestBackgroundAnalysis extends BackgroundAnalysisBase {
    constructor(private readonly _handleRequest: (request: BackgroundRequest) => void) {
        super(new NullConsole());
    }

    protected override enqueueRequest(request: BackgroundRequest) {
        this._handleRequest(request);
    }
}

const operations: {
    name: string;
    invoke: (analysis: TestBackgroundAnalysis) => Promise<unknown>;
    result: unknown;
}[] = [
    {
        name: 'analyzeFile',
        invoke: (analysis) => analysis.analyzeFile(Uri.empty(), CancellationToken.None),
        result: true,
    },
    {
        name: 'analyzeFileAndGetDiagnostics',
        invoke: (analysis) => analysis.analyzeFileAndGetDiagnostics(Uri.empty(), CancellationToken.None),
        result: [],
    },
    {
        name: 'getDiagnosticsForRange',
        invoke: (analysis) =>
            analysis.getDiagnosticsForRange(
                Uri.empty(),
                { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                CancellationToken.None
            ),
        result: [],
    },
    {
        name: 'generateTypeStubFiles',
        invoke: (analysis) =>
            analysis.generateTypeStubFiles(
                {
                    source: { targetImportPath: Uri.empty(), targetIsSingleFile: true, outputPath: Uri.empty() },
                    additionalFiles: [],
                },
                CancellationToken.None
            ),
        result: { files: [] },
    },
];

describe.each(operations)('$name message channel lifetime', ({ invoke, result }) => {
    test.each(['ok', 'failed', 'cancelled'] as const)('closes its channel after a %s response', async (kind) => {
        let responsePort: MessagePort | undefined;
        let closed: Promise<unknown> | undefined;
        const analysis = new TestBackgroundAnalysis((request) => {
            assert(request.port);
            responsePort = request.port;
            closed = once(responsePort, 'close');
            responsePort.postMessage({ kind, data: kind === 'ok' ? serialize(result) : 'background request failed' });
        });
        const close = jest.spyOn(MessagePort.prototype, 'close');
        try {
            if (kind === 'ok') {
                assert.deepStrictEqual(await invoke(analysis), result);
            } else {
                await assert.rejects(invoke(analysis), (error) =>
                    kind === 'cancelled' ? OperationCanceledException.is(error) : error === 'background request failed'
                );
            }
            assert(responsePort);
            expect(close.mock.contexts).toContain(responsePort);
            await closed;
        } finally {
            responsePort?.close();
            analysis.dispose();
            await closed;
            close.mockRestore();
        }
    });

    test('closes its channel when sending the request throws', async () => {
        let responsePort: MessagePort | undefined;
        let closed: Promise<unknown> | undefined;
        const failure = new Error('request could not be sent');
        const analysis = new TestBackgroundAnalysis((request) => {
            assert(request.port);
            responsePort = request.port;
            closed = once(responsePort, 'close');
            throw failure;
        });
        const close = jest.spyOn(MessagePort.prototype, 'close');
        try {
            await assert.rejects(invoke(analysis), (error) => error === failure);
            assert(responsePort);
            expect(close.mock.contexts).toContain(responsePort);
            await closed;
        } finally {
            responsePort?.close();
            analysis.dispose();
            await closed;
            close.mockRestore();
        }
    });
});
