'use strict';

var path = require('path');
var spawn = require('child_process').spawn;
var events = require('events');
var sh = require('shelljs');
var rl = require('readline');
var devnull = require('dev-null');
var fs = require('fs');

var getUsername = require('./username.js');

/**
 * WinExe
 * @param options
 * @returns {WinExe}
 * @constructor
 */
function WinExe(options) {
    this.host = options.host;
    this.username = getUsername(options.username);
    this.password = options.password;
    this.isWindows = process.platform === 'win32';
    this.options = options;

    if (this.isWindows) {
        if (sh.which('paexec')) {
            this.isPaExec = true;
            this.winexe = sh.which('paexec');
        } else if (fs.existsSync(path.join(__dirname, '..', 'bin', 'paexec.exe'))) {
            this.isPaExec = true;
            this.winexe = path.join(__dirname, '..', 'bin', 'paexec.exe');
        } else if (sh.which('psexec')) {
            this.isPsExec = true;
            this.winexe = sh.which('psexec');
        }
    } else if (sh.which('psexec.py')) {
        this.isPsExecPy = true;
        this.winexe = sh.which('psexec.py');
    } else if (sh.which('winexe')) {
        this.isWinExe = true;
        this.winexe = sh.which('winexe');
    } else if (process.platform === 'linux' && process.arch === 'x64') {
        this.isWinExe = true;
        this.winexe = path.join(__dirname, '..', 'bin', 'winexe_x64');
    }

    events.EventEmitter.call(this);

    return this;
}

WinExe.super_ = events.EventEmitter;

WinExe.prototype = Object.create(events.EventEmitter.prototype, {
    constructor: {
        value: WinExe,
        enumerable: false
    }
});

/**
 * Return args for winexe or psexec
 * @private
 */
WinExe.prototype._getArgs = function () {
    if(this.isWindows) {
        return this._getArgsForPsExec();
    }
    else if(/\.py$/.test(this.winexe)) {
        return this._getArgsForPsExecPy();
    }
    else {
        return this._getArgsForWinExe();
    }
};

/**
 * Prepares arguments for PsExec.py
 * @returns {Array}
 * @private
 */
WinExe.prototype._getArgsForPsExecPy = function () {
    var args = [];

    var target = '';
    if (this.username) {
        if (this.password) {
            target += this.username+':'+this.password;
        } else {
            target += this.username;
            args.push('-no-pass');
        }
        target += '@';
    }

    target += this.host;
    args.push(target);
    args.push(this.cmd);

    return args;
};

/**
 * Prepares arguments for winexe
 * @returns {Array}
 * @private
 */
WinExe.prototype._getArgsForWinExe = function () {
    var args = [];

    if (this.username) {
        if (this.password) {
            args.push('--user=' + this.username + '%' + this.password);
        } else {
            args.push('--user=' + this.username);
        }
    }

    if (!this.password) {
        args.push('--no-pass');
    }

    if (this.options) {
        if (this.options.reinstall) {
            args.push('--reinstall');
        }

        if (this.options.uninstall) {
            args.push('--uninstall');
        }

        if (this.options.system) {
            args.push('--system');
        }
    }

    args.push('//' + this.host, this.cmd);

    return args;
};

/**
 * Prepares arguments for psexec
 * @returns {Array}
 * @private
 */
WinExe.prototype._getArgsForPsExec = function () {
    var args = [
        '\\\\' + this.host
    ];

    if (this.username) {
        args.push('-u', this.username);
    }

    if (this.password) {
        args.push('-p', this.password);
    }

    if (this.options) {
        if (this.options.system) {
            args.push('-s');
        }

        if (this.options.elevated) {
            args.push('-h');
        }

        if (this.options.copy) {
            args.push('-c');

            if (typeof this.options.copy === 'object') {
                if (this.options.copy.force) {
                    args.push('-f');
                }
                else if (this.options.copy.version) {
                    args.push('-v');
                }

                if (this.options.copy.file) {
                    args.push('-csrc', this.options.copy.file);
                }
                else if (this.options.copy.list) {
                    args.push('-clist', this.options.copy.list);
                }
            }
        }
    }

    if(this.isPsExec) {
    args.push('-accepteula');
    args.push('-nobanner');
    }

    var inQuote = false;
    var cmd = '';

    for (var i = 0; i < this.cmd.length; i += 1) {
        if (this.cmd[i] === '"') {
            inQuote = !inQuote;
            cmd += this.cmd[i]; // Добавляем кавычки
        } else if (this.cmd[i] === ' ') {
            cmd += (inQuote) ? ' ' : '\u0001';
        } else {
            cmd += this.cmd[i];
        }
    }

    args = args.concat(cmd.split('\u0001'));

    return args;
};

/**
 * Spawn winexe, psexec, or psexec.py with arguments
 * @param callback
 * @private
 */
WinExe.prototype._exec = function (callback) {
    var self = this;
    var stdio = (this.isWindows) ? ['ignore', 'pipe', 'pipe'] : undefined;

    const options = {
        cwd: path.join(__dirname, '..'),
        stdio: stdio
    };

    if (process.platform === 'win32') {
        options.shell = true;
    }

    var cp = spawn(this.winexe, this._getArgs(), options);

    var stdoutRL = rl.createInterface({input: cp.stdout, output: devnull()});
    var stderrRL = rl.createInterface({input: cp.stderr, output: devnull()});

    var stdout = '';
    var watchDog;

    if (this.options.timeout) {
        watchDog = setTimeout(function () {
            try {
                process.kill(cp.pid, 'SIGKILL');
            } catch (e) {}
        }, this.options.timeout);
    }

    stdoutRL.on('line', function (data) {
        // psexec.py has a bunch of debugging output in stdout.. even though it
        // SHOULD be in stderr. I'm just discarding it though.
        if(self.isPsExecPy) {
            if(/^\[[\*!]\]/.test(data)) {
                return;
            }
            else if(/^Impacket /.test(data)) {
                return;
            }
        }
        else if(self.isPsExec) {
            if(/PsExec v\d\.\d - Execute processes remotely/.test(data)) {
                return;
            }
            else if (/Copyright \(C\) 2001-20\d\d Mark Russinovich/.test(data)) {
                return;
            }
            else if (/Sysinternals - www\.sysinternals\.com/.test(data)) {
                return;
            }
        }
        stdout += data + '\n';
        self.emit('stdout', data);
    });

    var stderr = '';

    stderrRL.on('line', function (data) {
        stderr += data + '\n';
        self.emit('stderr', data);
    });

    cp.on('error', function (err) {
        if (watchDog) {
            clearTimeout(watchDog);
        }
        self.emit('error', err);
    });

    cp.on('close', function (code) {
        if (watchDog) {
            clearTimeout(watchDog);
        }
        if (code !== 0) {
            callback(new Error('Exit code: ' + code + '. ' + stderr.trim()), stdout, stderr);
        } else {
            callback(null, stdout, stderr);
        }
    });
};

/**
 * Run
 * @param cmd
 * @param options
 * @param callback
 * @returns {WinExe}
 */
WinExe.prototype.run = function (cmd, options, callback) {
    this.cmd = cmd;

    if (typeof options === 'function') {
        callback = options;
    } else {
        this.options = options || {};
    }

    if (typeof callback !== 'function') {
        callback = function () {
        };
    }

    this._exec(callback);

    return this;
};

module.exports = WinExe;
