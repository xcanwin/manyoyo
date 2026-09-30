'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const BIN_PATH = path.join(__dirname, '../../bin/manyoyo.js');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : 0;
            server.close(err => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(port);
            });
        });
    });
}

async function waitForHttpReady(port, attempts = 30, delayMs = 200) {
    for (let i = 0; i < attempts; i += 1) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/auth/login`);
            if (response.status === 200 || response.status === 404 || response.status === 405) {
                return;
            }
        } catch (e) {
            // keep polling
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    throw new Error(`HTTP 服务未在预期时间内启动: ${port}`);
}

async function waitForHttpClosed(port, attempts = 30, delayMs = 200) {
    for (let i = 0; i < attempts; i += 1) {
        try {
            await fetch(`http://127.0.0.1:${port}/auth/login`);
        } catch (e) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    throw new Error(`HTTP 服务未在预期时间内关闭: ${port}`);
}

function detectRuntime() {
    for (const name of ['docker', 'podman']) {
        const result = spawnSync(name, ['info'], { stdio: 'ignore', timeout: 15000 });
        if (result.status === 0) return name;
    }
    return '';
}

const runtime = detectRuntime();
const describeWithRuntime = runtime ? describe : describe.skip;

if (!runtime) {
    console.warn('[integration] 未检测到可用的 docker/podman（docker info / podman info 均失败），跳过容器运行时集成测试');
}

describeWithRuntime('Container runtime integration', () => {
    describe('Container Mode (setContMode)', () => {
        test('dind mode adds --privileged and prints the safety hint', () => {
            const output = execSync(`node ${BIN_PATH} config command -m dind -n test-dind`, { encoding: 'utf-8' });
            expect(output).toContain('开启安全的容器嵌套容器模式');
            expect(output).toContain('--privileged');
            expect(output).not.toContain('docker.sock');
        });

        test('sock mode adds docker.sock mount and prints the danger hint', () => {
            const output = execSync(`node ${BIN_PATH} config command -m sock -n test-sock`, { encoding: 'utf-8' });
            expect(output).toContain('开启危险的容器嵌套容器模式');
            expect(output).toContain('--privileged');
            expect(output).toContain('/var/run/docker.sock:/var/run/docker.sock');
            expect(output).toContain('DOCKER_HOST=unix:///var/run/docker.sock');
        });

        test('common mode adds no extra args', () => {
            const output = execSync(`node ${BIN_PATH} config command -m common -n test-common`, { encoding: 'utf-8' });
            expect(output).not.toContain('--privileged');
            expect(output).not.toContain('docker.sock');
        });

        test('unknown mode prints a warning and exits 0 without extra args', () => {
            const output = execSync(`node ${BIN_PATH} config command -m badmode -n test-bad`, { encoding: 'utf-8' });
            expect(output).toContain('未知模式: badmode');
            expect(output).not.toContain('--privileged');
        });
    });

    describe('Serve detached (requires container runtime)', () => {
            test('serve -d should print generated password when pass not provided', async () => {
                const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-serve-detach-'));
                const port = await getFreePort();
                const output = execSync(`node ${BIN_PATH} serve 127.0.0.1:${port} -d`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });

                const pidMatch = output.match(/^PID:\s+(\d+)$/m);
                const passMatch = output.match(/^登录密码\(本次随机\):\s+([A-Za-z0-9]+)$/m);
                expect(pidMatch).toBeTruthy();
                expect(passMatch).toBeTruthy();

                const pid = pidMatch ? Number(pidMatch[1]) : 0;
                const password = passMatch ? passMatch[1] : '';

                try {
                    await new Promise(resolve => setTimeout(resolve, 1200));
                    const loginRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: 'admin', password })
                    });
                    expect(loginRes.status).toBe(200);
                } finally {
                    if (pid) {
                        try {
                            process.kill(pid, 'SIGTERM');
                        } catch (e) {
                            // ignore process cleanup failures in test teardown
                        }
                    }
                    fs.rmSync(tempHome, { recursive: true, force: true });
                }
            });

            test('serve --stop should stop detached instance by listen', async () => {
                const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-serve-stop-'));
                const port = await getFreePort();
                const output = execSync(`node ${BIN_PATH} serve 127.0.0.1:${port} -d`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });
                const pidMatch = output.match(/^PID:\s+(\d+)$/m);
                const pid = pidMatch ? Number(pidMatch[1]) : 0;

                try {
                    await waitForHttpReady(port);
                    const stopOutput = execSync(`node ${BIN_PATH} serve 127.0.0.1:${port} --stop`, {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome }
                    });
                    expect(stopOutput).toContain('已停止');
                    expect(stopOutput).toContain(`127.0.0.1:${port}`);
                    await waitForHttpClosed(port);
                } finally {
                    if (pid) {
                        try {
                            process.kill(pid, 'SIGTERM');
                        } catch (e) {
                            // ignore process cleanup failures in test teardown
                        }
                    }
                    fs.rmSync(tempHome, { recursive: true, force: true });
                }
            }, 20000);

            test('serve --stop without listen should require explicit listen', async () => {
                const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-serve-stop-many-'));
                const portA = await getFreePort();
                const portB = await getFreePort();
                const outputA = execSync(`node ${BIN_PATH} serve 127.0.0.1:${portA} -d`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });
                const outputB = execSync(`node ${BIN_PATH} serve 127.0.0.1:${portB} -d`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });
                const pidA = Number((outputA.match(/^PID:\s+(\d+)$/m) || [])[1] || 0);
                const pidB = Number((outputB.match(/^PID:\s+(\d+)$/m) || [])[1] || 0);

                try {
                    await waitForHttpReady(portA);
                    await waitForHttpReady(portB);
                    expect(() => {
                        execSync(`node ${BIN_PATH} serve --stop`, {
                            encoding: 'utf-8',
                            env: { ...process.env, HOME: tempHome },
                            stdio: 'pipe'
                        });
                    }).toThrow(/必须显式传入 listen/);
                } finally {
                    try {
                        execSync(`node ${BIN_PATH} serve 127.0.0.1:${portA} --stop`, {
                            encoding: 'utf-8',
                            env: { ...process.env, HOME: tempHome },
                            stdio: 'pipe'
                        });
                    } catch (e) {}
                    try {
                        execSync(`node ${BIN_PATH} serve 127.0.0.1:${portB} --stop`, {
                            encoding: 'utf-8',
                            env: { ...process.env, HOME: tempHome },
                            stdio: 'pipe'
                        });
                    } catch (e) {}
                    if (pidA) {
                        try { process.kill(pidA, 'SIGTERM'); } catch (e) {}
                    }
                    if (pidB) {
                        try { process.kill(pidB, 'SIGTERM'); } catch (e) {}
                    }
                    fs.rmSync(tempHome, { recursive: true, force: true });
                }
            }, 20000);

            test('serve --stop should only stop the specified detached instance', async () => {
                const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-serve-stop-specific-'));
                const portA = await getFreePort();
                const portB = await getFreePort();
                const outputA = execSync(`node ${BIN_PATH} serve 127.0.0.1:${portA} -U admin -P 123 -d`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });
                const outputB = execSync(`node ${BIN_PATH} serve 127.0.0.1:${portB} -U admin -P 123 -d`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });
                const pidA = Number((outputA.match(/^PID:\s+(\d+)$/m) || [])[1] || 0);
                const pidB = Number((outputB.match(/^PID:\s+(\d+)$/m) || [])[1] || 0);

                try {
                    await waitForHttpReady(portA);
                    await waitForHttpReady(portB);
                    const stopOutput = execSync(`node ${BIN_PATH} serve 127.0.0.1:${portA} --stop`, {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome }
                    });
                    expect(stopOutput).toContain(`127.0.0.1:${portA}`);
                    await waitForHttpClosed(portA);
                    await waitForHttpReady(portB);
                    const loginRes = await fetch(`http://127.0.0.1:${portB}/auth/login`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: 'admin', password: '123' })
                    });
                    expect(loginRes.status).toBe(200);
                } finally {
                    try {
                        execSync(`node ${BIN_PATH} serve 127.0.0.1:${portA} --stop`, {
                            encoding: 'utf-8',
                            env: { ...process.env, HOME: tempHome },
                            stdio: 'pipe'
                        });
                    } catch (e) {}
                    try {
                        execSync(`node ${BIN_PATH} serve 127.0.0.1:${portB} --stop`, {
                            encoding: 'utf-8',
                            env: { ...process.env, HOME: tempHome },
                            stdio: 'pipe'
                        });
                    } catch (e) {}
                    if (pidA) {
                        try { process.kill(pidA, 'SIGTERM'); } catch (e) {}
                    }
                    if (pidB) {
                        try { process.kill(pidB, 'SIGTERM'); } catch (e) {}
                    }
                    fs.rmSync(tempHome, { recursive: true, force: true });
                }
            }, 20000);

            test('serve --restart should restart detached instance by listen', async () => {
                const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-serve-restart-'));
                const port = await getFreePort();
                const outputA = execSync(`node ${BIN_PATH} serve 127.0.0.1:${port} -U admin -P 123 -d`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });
                const pidA = Number((outputA.match(/^PID:\s+(\d+)$/m) || [])[1] || 0);

                try {
                    await waitForHttpReady(port);
                    const restartOutput = execSync(`node ${BIN_PATH} serve 127.0.0.1:${port} -U admin -P 123 -d --restart`, {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome }
                    });
                    const pidB = Number((restartOutput.match(/^PID:\s+(\d+)$/m) || [])[1] || 0);

                    expect(restartOutput).toContain('已停止');
                    expect(restartOutput).toContain(`MANYOYO Web 服务已在后台启动: http://127.0.0.1:${port}`);
                    expect(pidB).toBeGreaterThan(0);
                    expect(pidB).not.toBe(pidA);

                    await waitForHttpReady(port);
                    const loginRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: 'admin', password: '123' })
                    });
                    expect(loginRes.status).toBe(200);

                    execSync(`node ${BIN_PATH} serve 127.0.0.1:${port} --stop`, {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome },
                        stdio: 'pipe'
                    });
                } finally {
                    try {
                        execSync(`node ${BIN_PATH} serve 127.0.0.1:${port} --stop`, {
                            encoding: 'utf-8',
                            env: { ...process.env, HOME: tempHome },
                            stdio: 'pipe'
                        });
                    } catch (e) {}
                    if (pidA) {
                        try { process.kill(pidA, 'SIGTERM'); } catch (e) {}
                    }
                    fs.rmSync(tempHome, { recursive: true, force: true });
                }
            }, 20000);
    });

    describe('Doctor Command', () => {
        test('doctor --json outputs a stable diagnostic report with a container runtime', () => {
            const stdout = execSync(`node ${BIN_PATH} doctor --json`, { encoding: 'utf-8' });
            const report = JSON.parse(stdout);

            expect(report).toEqual(expect.objectContaining({
                ok: expect.any(Boolean),
                checks: expect.any(Array)
            }));
            expect(report.checks.map(check => check.code)).toEqual(expect.arrayContaining(['MODE_VALID']));
        });
    });
});
