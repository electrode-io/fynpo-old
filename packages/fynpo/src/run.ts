/* reuses some of the awesome work from https://github.com/lerna/lerna/blob/main/commands/run/index.js */
/* eslint-disable consistent-return */

import xsh from "xsh";
import Promise from "bluebird";
import logger from "./logger";
import * as utils from "./utils";
import _ from "lodash";
import { npmRunScriptStreaming, npmRunScript } from "./npm-run-script";
import PQueue from "p-queue";
import boxen from "boxen";
import chalk from "chalk";

export default class Run {
  _cwd;
  _script;
  _packages;
  _options;
  _args;
  _npmClient;
  _circularMap;

  constructor(opts, args, data) {
    this._script = args.script;
    this._cwd = opts.dir || opts.cwd;
    this._packages = data.packages;
    this._options = opts;
    this._args = this._options["--"] || [];
    this._npmClient = "npm";
    this._circularMap = {};
    data.circulars.reduce((mapping, locks) => {
      locks.forEach((name) => (mapping[name] = locks));
      return mapping;
    }, this._circularMap);
  }

  _sh(command, cwd = this._cwd, silent = true) {
    return xsh.exec(
      {
        silent,
        cwd,
        env: Object.assign({}, process.env, { PWD: cwd }),
      },
      command
    );
  }

  getOpts(pkg) {
    return {
      args: this._args,
      npmClient: this._npmClient,
      prefix: this._options.prefix,
      reject: this._options.bail,
      pkg,
    };
  }

  excuteScript(pkg, pkgQueue) {
    if (pkg.ignore) {
      return true;
    }

    if (pkg.executed === "pending") return false;
    if (pkg.executed) return true;

    let pending = 0;

    _.each(pkg.localDeps, (depName) => {
      const depPkg = this._packages[depName] || {};
      const scriptToRun = _.get(depPkg, ["pkgJson", "scripts", this._script]);
      const circulars = this._circularMap[depName] || [];
      if (scriptToRun && !circulars.includes(pkg.name) && !this.excuteScript(depPkg, pkgQueue)) {
        pending++;
      }
    });

    if (pending === 0 && !pkg.executed) {
      pkg.executed = "pending";
      pkgQueue.push(pkg);
    }

    return false;
  }

  getRunner() {
    return this._options.stream
      ? (pkg) => this.runScriptWithStream(pkg)
      : (pkg) => this.runScript(pkg);
  }

  runScript(pkg) {
    const timer = utils.timer();
    return npmRunScript(this._script, this.getOpts(pkg)).then((result) => {
      const duration = (timer() / 1000).toFixed(1);
      logger.info(result.stdout);
      logger.info(`Ran npm script ${this._script} in ${pkg.name} in ${duration}s:"`);
      return result;
    });
  }

  runScriptWithStream(pkg) {
    return npmRunScriptStreaming(this._script, this.getOpts(pkg));
  }

  runScriptsInLexical(packagesToRun) {
    return Promise.map(packagesToRun, this.getRunner(), { concurrency: this._options.concurrency });
  }

  runScriptsInParallel(packagesToRun) {
    const queue = new PQueue({ concurrency: this._options.concurrency });
    const errors = [];
    const results = [];
    queue.addAll(
      packagesToRun.map((pkg) => {
        // cannot run the script here, must return a function that will run the script
        // else we start running script for all packages at once
        return () => {
          // TODO: expose continueOnError option
          if (!this._options.continueOnError && errors.length > 0) {
            return;
          }

          const msg = boxen(
            `
Queueing package ${pkg.name} to run script '${this._script}'
`,
            { padding: { top: 0, right: 2, left: 2, bottom: 0 } }
          );

          logger.prefix(false).info(msg);
          let error: Error;
          return this.runScriptWithStream(pkg)
            .then((x) => results.push(x))
            .catch((err: { pkg: any } & Error) => {
              error = err;
              err.pkg = pkg;
              errors.push(err);
              results.push(err);
            })
            .finally((x) => {
              const m = `
${error ? "ERROR - Failed" : "Completed"} run script '${this._script}' for package ${pkg.name}
`;
              const msg = boxen(error ? chalk.red(m) : chalk.green(m), {
                padding: { top: 0, right: 2, left: 2, bottom: 0 },
              });
              logger.prefix(false).info(msg);
              return x;
            });
        };
      })
    );

    return queue.onIdle().then(() => {
      return results;
    });
  }

  runScriptsInTopological(packagesToRun) {
    // TODO: what does topo run mean?
    return this.runScriptsInParallel(packagesToRun);
  }

  exec() {
    if (!this._script) {
      logger.error("You must specify a lifecycle script to run!");
      process.exit(1);
    }
    const packagesToRun = Object.values(this._packages).filter((pkg: any) => {
      const scriptToRun = _.get(pkg, ["pkgJson", "scripts", this._script]);
      return scriptToRun && !pkg.ignore;
    });

    const count = packagesToRun.length;

    if (!count) {
      logger.info(`No packages found with script ${this._script}`);
      return;
    }

    const joinedCommand = [this._npmClient, "run", this._script].concat(this._args).join(" ");
    const pkgMsg = count === 1 ? "package" : "packages";

    logger.info(
      `Executing command ${joinedCommand} in ${count} ${pkgMsg} - parallel ${this._options.parallel} - topological ${this._options.sort}`
    );
    const timer = utils.timer();

    return Promise.resolve()
      .then(() => {
        if (this._options.parallel) {
          return this.runScriptsInParallel(packagesToRun);
        } else if (this._options.sort) {
          return this.runScriptsInTopological(packagesToRun);
        } else {
          return this.runScriptsInLexical(packagesToRun);
        }
      })
      .then((results: ({ failed: boolean; exitCode: number } & Error)[]) => {
        if (Array.isArray(results) && results.some((result) => result.failed)) {
          logger.error(`ERROR: failure occurred while running script in these packages`);
          // propagate "highest" error code, it's probably the most useful
          const failures = results.filter((result) => result.failed);
          failures.forEach((result) => {
            const name = _.get(result, "pkg.name");
            logger.error(`  - ${name} - exitCode ${result.exitCode}`);
          });
          const codes = failures.map((error) => error.exitCode);
          const exitCode = Math.max(...codes, 1);
          process.exitCode = exitCode;
        } else {
          const duration = (timer() / 1000).toFixed(1);
          const messages = packagesToRun.map((pkg: any) => ` - ${pkg.name}`);
          logger.info(
            `
Finished run npm script '${this._script}' in ${count} ${pkgMsg} in ${duration}s:
${messages.join("\n")}
`
          );
        }
      })
      .catch((err) => {
        logger.error(`ERROR - caught exception running scripts`, err);
        process.exit(1);
      });
  }
}
