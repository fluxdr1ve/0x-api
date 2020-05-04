import { logUtils as log } from '@0x/utils';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const apiRootDir = path.normalize(path.resolve(`${__dirname}/../../../`));
const testRootDir = `${apiRootDir}/test`;

export enum LogType {
    Console,
    File,
}

/**
 * The configuration object that provides information on how verbose the logs
 * should be and where they should be located.
 * @param apiLogType The location where the API logs should be logged.
 * @param dependencyLogType The location where the API's dependency logs should be logged.
 */
export interface LoggingConfig {
    apiLogType?: LogType;
    dependencyLogType?: LogType;
}

let start: ChildProcessWithoutNullStreams;

/**
 * Sets up a 0x-api instance.
 * @param logConfig Where logs should be directed.
 */
export async function setupApiAsync(suiteName: string, logConfig: LoggingConfig = {}): Promise<void> {
    if (start) {
        throw new Error('Old 0x-api instance has not been torn down');
    }
    await setupDependenciesAsync(suiteName, logConfig.dependencyLogType);
    start = spawn('yarn', ['start'], {
        cwd: apiRootDir,
        env: process.env,
    });
    directLogs(start, suiteName, 'start', logConfig.apiLogType);
    await waitForApiStartupAsync(start);
}

/**
 * Tears down the old 0x-api instance.
 * @param suiteName The name of the test suite that is using this function. This
 *        helps to make the logs more intelligible.
 * @param logType Indicates where logs should be directed.
 */
export async function teardownApiAsync(suiteName: string, logType?: LogType): Promise<void> {
    if (!start) {
        throw new Error('There is no 0x-api instance to tear down');
    }
    start.kill();
    start = undefined;
    await teardownDependenciesAsync(suiteName, logType);
}

let didTearDown = false;

/**
 * Sets up 0x-api's dependencies.
 * @param suiteName The name of the test suite that is using this function. This
 *        helps to make the logs more intelligible.
 * @param logType Indicates where logs should be directed.
 */
export async function setupDependenciesAsync(suiteName: string, logType?: LogType): Promise<void> {
    await createFreshDockerComposeFileOnceAsync();

    // Tear down any existing dependencies or lingering data if a tear-down has
    // not been called yet.
    if (!didTearDown) {
        await teardownDependenciesAsync(suiteName, logType);
    }

    // Spin up the 0x-api dependencies
    const up = spawn('docker-compose', ['up', '--build', '--force-recreate'], {
        cwd: testRootDir,
        env: {
            ...process.env,
            ETHEREUM_RPC_URL: 'http://ganache:8545',
            ETHEREUM_CHAIN_ID: '1337',
        },
    });
    directLogs(up, suiteName, 'up', logType);
    didTearDown = false;

    // Wait for the dependencies to boot up.
    await waitForDependencyStartupAsync(up);
}

/**
 * Tears down 0x-api's dependencies.
 * @param suiteName The name of the test suite that is using this function. This
 *        helps to make the logs more intelligible.
 * @param logType Indicates where logs should be directed.
 */
export async function teardownDependenciesAsync(suiteName: string, logType?: LogType): Promise<void> {
    // Tear down any existing docker containers from the `docker-compose.yml` file.
    const down = spawn('docker-compose', ['down', '-v', '--rmi', 'all'], {
        cwd: testRootDir,
    });
    directLogs(down, suiteName, 'down', logType);
    const downTimeout = 20000;
    await waitForCloseAsync(down, 'down', downTimeout);
    didTearDown = true;
}

/**
 * FIXME(jalextowle): Add comment
 */
export async function setupMeshAsync(suiteName: string, logType?: LogType): Promise<void> {
    await createFreshDockerComposeFileOnceAsync();
    // Spin up a 0x-mesh instance
    const up = spawn('docker-compose', ['up', '--build', 'mesh'], {
        cwd: testRootDir,
        env: {
            ...process.env,
            ETHEREUM_RPC_URL: 'http://ganache:8545',
            ETHEREUM_CHAIN_ID: '1337',
        },
    });
    directLogs(up, suiteName, 'up', logType);

    await waitForMeshStartupAsync(up);

    // HACK(jalextowle): For some reason, Mesh Clients would connect to
    // the old mesh node. Try to remove this.
    await sleepAsync(3); // tslint:disable-line:custom-no-magic-numbers
}

/**
 * FIXME(jalextowle): Add comments
 */
export async function teardownMeshAsync(suiteName: string, logType?: LogType): Promise<void> {
    const stop = spawn('docker-compose', ['stop', 'mesh'], {
        cwd: testRootDir,
    });
    directLogs(stop, suiteName, 'mesh_stop', logType);
    const stopTimeout = 2000;
    await waitForCloseAsync(stop, 'mesh_stop', stopTimeout);

    const rm = spawn('docker-compose', ['rm', '-f', '-s', '-v', 'mesh'], {
        cwd: testRootDir,
    });
    directLogs(rm, suiteName, 'mesh_rm', logType);
    const rmTimeout = 2000;
    await waitForCloseAsync(rm, 'mesh_rm', rmTimeout);
}

function directLogs(
    stream: ChildProcessWithoutNullStreams,
    suiteName: string,
    command: string,
    logType?: LogType,
): void {
    if (logType === LogType.Console) {
        stream.stdout.on('data', chunk => {
            neatlyPrintChunk(`[${suiteName}-${command}]`, chunk);
        });
        stream.stderr.on('data', chunk => {
            neatlyPrintChunk(`[${suiteName}-${command} | error]`, chunk);
        });
    } else if (logType === LogType.File) {
        const logStream = fs.createWriteStream(`${apiRootDir}/${suiteName}_${command}_logs`, { flags: 'a' });
        const errorStream = fs.createWriteStream(`${apiRootDir}/${suiteName}_${command}_errors`, { flags: 'a' });
        stream.stdout.pipe(logStream);
        stream.stderr.pipe(errorStream);
    }
}

const volumeRegex = new RegExp(/[ \t\r]*volumes:.*\n([ \t\r]*-.*\n)+/, 'g');
let didCreateFreshComposeFile = false;

// Removes the volume fields from the docker-compose.yml to fix a
// docker compatibility issue with Linux systems.
// Issue: https://github.com/0xProject/0x-api/issues/186
async function createFreshDockerComposeFileOnceAsync(): Promise<void> {
    if (didCreateFreshComposeFile) {
        return;
    }
    const dockerComposeString = (await promisify(fs.readFile)(`${apiRootDir}/docker-compose.yml`)).toString();
    await promisify(fs.writeFile)(`${testRootDir}/docker-compose.yml`, dockerComposeString.replace(volumeRegex, ''));
    didCreateFreshComposeFile = true;
}

function neatlyPrintChunk(prefix: string, chunk: Buffer): void {
    const data = chunk.toString().split('\n');
    data.filter((datum: string) => datum !== '').map((datum: string) => {
        log.log(prefix, datum.trim());
    });
}

async function waitForCloseAsync(
    stream: ChildProcessWithoutNullStreams,
    command: string,
    timeout: number,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        stream.on('close', () => {
            resolve();
        });
        setTimeout(() => {
            reject(new Error(`Timed out waiting for "${command}" to close`));
        }, timeout);
    });
}

async function waitForApiStartupAsync(logStream: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        logStream.stdout.on('data', (chunk: Buffer) => {
            const data = chunk.toString().split('\n');
            for (const datum of data) {
                if (/API \(HTTP\) listening on port 3000!/.test(datum)) {
                    resolve();
                }
            }
        });
        setTimeout(() => {
            reject(new Error('Timed out waiting for 0x-api logs'));
        }, 20000); // tslint:disable-line:custom-no-magic-numbers
    });
}

async function waitForMeshStartupAsync(logStream: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let didStartWSServer = false;
        let didStartHttpServer = false;
        logStream.stdout.on('data', (chunk: Buffer) => {
            const data = chunk.toString().split('\n');
            for (const datum of data) {
                if (!didStartHttpServer && /.*mesh.*started HTTP RPC server/.test(datum)) {
                    didStartHttpServer = true;
                } else if (!didStartWSServer && /.*mesh.*started WS RPC server/.test(datum)) {
                    didStartWSServer = true;
                }

                if (didStartHttpServer && didStartWSServer) {
                    resolve();
                }
            }
        });
        setTimeout(() => {
            reject(new Error('Timed out waiting for 0x-mesh logs'));
        }, 5000); // tslint:disable-line:custom-no-magic-numbers
    });
}

async function waitForDependencyStartupAsync(logStream: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const hasSeenLog = [0, 0, 0];
        logStream.stdout.on('data', (chunk: Buffer) => {
            const data = chunk.toString().split('\n');
            for (const datum of data) {
                if (hasSeenLog[0] < 2 && /.*mesh.*started HTTP RPC server/.test(datum)) {
                    hasSeenLog[0]++;
                } else if (hasSeenLog[1] < 2 && /.*mesh.*started WS RPC server/.test(datum)) {
                    hasSeenLog[1]++;
                } else if (
                    // NOTE(jalextowle): Because the `postgres` database is deleted before every
                    // test run, we must skip over the "autovacuming" step that creates a new
                    // postgres table.
                    hasSeenLog[2] < 2 &&
                    /.*postgres.*database system is ready to accept connections/.test(datum)
                ) {
                    hasSeenLog[2]++;
                }

                if (hasSeenLog[0] === 1 && hasSeenLog[1] === 1 && hasSeenLog[2] === 2) {
                    // TODO(jalextowle): Is this necessary?
                    setTimeout(resolve, 20000); // tslint:disable-line:custom-no-magic-numbers
                }
            }
        });
        setTimeout(() => {
            reject(new Error('Timed out waiting for dependency logs'));
        }, 150000); // tslint:disable-line:custom-no-magic-numbers
    });
}

async function sleepAsync(timeSeconds: number): Promise<void> {
    return new Promise<void>(resolve => {
        const secondsPerMillisecond = 1000;
        setTimeout(resolve, timeSeconds * secondsPerMillisecond);
    });
}
