"use strict";

//
// Manages all sources that package data could come from.
// - local cache
// - git repo
// - local dir
// - npm registry
//

/* eslint-disable no-magic-numbers, prefer-template, max-statements */

const Promise = require("bluebird");
const cacache = require("cacache");
const createDefer = require("./util/defer");
const os = require("os");
const pacote = require("pacote");
const _ = require("lodash");
const chalk = require("chalk");
const Fs = require("./util/file-ops");
const logger = require("./logger");
const mkdirp = require("mkdirp");
const Path = require("path");
const PromiseQueue = require("./util/promise-queue");
const Inflight = require("./util/inflight");
const logFormat = require("./util/log-format");
const semverUtil = require("./util/semver");
const longPending = require("./long-pending");
const { LOCAL_VERSION_MAPS, PACKAGE_RAW_INFO, DEP_ITEM } = require("./symbols");
const { LONG_WAIT_META, FETCH_META, FETCH_PACKAGE } = require("./log-items");
const PkgPreper = require("pkg-preper");
const VisualExec = require("visual-exec");
const { readPkgJson } = require("./util/fyntil");
const { MARK_URL_SPEC } = require("./constants");
const pipe = Promise.promisify(require("mississippi").pipe);

const WATCH_TIME = 5000;

class PkgSrcManager {
  constructor(options) {
    this._options = _.defaults({}, options, {
      registry: "",
      fynCacheDir: ""
    });
    this._meta = {};
    this._cacheDir = this._options.fynCacheDir;
    mkdirp.sync(this._cacheDir);
    this._inflights = {
      meta: new Inflight()
    };
    this._fyn = options.fyn;

    this._localMeta = {};
    this._netQ = new PromiseQueue({
      concurrency: this._fyn.concurrency,
      stopOnError: true,
      processItem: x => this.processItem(x),
      watchTime: WATCH_TIME
    });

    this._netQ.on("fail", data => logger.error(data));
    this._netQ.on("watch", items => {
      longPending.onWatch(items, {
        name: LONG_WAIT_META,
        filter: x => x.item.type === "meta",
        makeId: x => logFormat.pkgId(x.item),
        _save: false
      });
    });

    const registry = _.pickBy(
      this._options,
      (v, key) => key === "registry" || key.endsWith(":registry")
    );

    logger.debug("pkg src manager registry", JSON.stringify(registry));

    this._pacoteOpts = Object.assign({ cache: this._cacheDir }, registry);

    this._metaStat = {
      wait: 0,
      inTx: 0,
      done: 0
    };
    this._lastMetaStatus = "waiting...";
  }

  processItem(x) {
    if (x.type === "meta") {
      return this.netRetrieveMeta(x);
    }
    return undefined;
  }

  makePkgCacheDir(pkgName) {
    const pkgCacheDir = Path.join(this._cacheDir, pkgName);
    mkdirp.sync(pkgCacheDir);
    return pkgCacheDir;
  }

  getSemverAsFilepath(semver) {
    if (semver.startsWith("file:")) {
      return semver.substr(5);
    } else if (semver.startsWith("/") || semver.startsWith("./") || semver.startsWith("../")) {
      return semver;
    } else if (semver.startsWith("~/")) {
      return Path.join(os.homedir(), semver.substr(1));
    }
    return false;
  }

  getLocalPackageMeta(item, resolved) {
    return _.get(this._localMeta, [item.name, "byVersion", resolved]);
  }

  getAllLocalMetaOfPackage(name) {
    return _.get(this._localMeta, [name, "byVersion"]);
  }

  getPacoteOpts(extra) {
    return Object.assign({}, extra, this._pacoteOpts);
  }

  /* eslint-disable max-statements */
  fetchLocalItem(item) {
    const localPath = item.semverPath;

    if (!localPath) return false;

    let fullPath;

    if (!Path.isAbsolute(localPath)) {
      const parent = item.parent;
      if (parent.localType) {
        fullPath = Path.join(parent.fullPath, localPath);
      } else {
        fullPath = Path.resolve(this._fyn.cwd, localPath);
      }
    } else {
      fullPath = localPath;
    }

    item.fullPath = fullPath;
    const pkgJsonFile = Path.join(fullPath, "package.json");

    logger.debug("fetchLocalItem localPath", localPath, "fullPath", fullPath);

    const existLocalMeta = _.get(this._localMeta, [item.name, "byPath", fullPath]);

    if (existLocalMeta) {
      existLocalMeta[LOCAL_VERSION_MAPS][item.semver] = existLocalMeta.localId;
      return Promise.resolve(existLocalMeta);
    }

    return this._fyn.loadPackageJsonFile(pkgJsonFile).then(json => {
      const version = semverUtil.localify(json.version, item.localType);
      const name = item.name || json.name;
      json.dist = {
        localPath,
        fullPath
      };
      const localMeta = {
        local: item.localType,
        localId: version,
        name,
        json,
        jsonStr: json[PACKAGE_RAW_INFO].str,
        versions: {
          [version]: json
        },
        "dist-tags": {
          latest: version
        },
        [LOCAL_VERSION_MAPS]: {
          [item.semver]: version
        }
      };

      logger.debug(
        "return local meta for",
        item.name,
        item.semver,
        "at",
        fullPath,
        "local version",
        version
      );

      _.set(this._localMeta, [name, "byPath", fullPath], localMeta);
      _.set(this._localMeta, [name, "byVersion", version], localMeta);

      return localMeta;
    });
  }

  updateFetchMetaStatus(_render) {
    const { wait, inTx, done } = this._metaStat;
    const statStr = `(${chalk.red(wait)}⇨ ${chalk.yellow(inTx)}⇨ ${chalk.green(done)})`;
    logger.updateItem(FETCH_META, {
      msg: `${statStr} ${this._lastMetaStatus}`,
      _render,
      _save: _render
    });
  }

  netRetrieveMeta(qItem) {
    const pkgName = qItem.item.name;

    const startTime = Date.now();

    const updateItem = status => {
      if (status !== undefined) {
        status = chalk.cyan(`${status}`);
        const time = logFormat.time(Date.now() - startTime);
        const dispName = chalk.red.bgGreen(pkgName);
        this._lastMetaStatus = `${status} ${time} ${dispName}`;
        this.updateFetchMetaStatus();
      }
    };

    const pacoteRequest = () => {
      return pacote
        .packument(
          pkgName,
          this.getPacoteOpts({
            "full-metadata": true,
            "fetch-retries": 3
          })
        )
        .tap(x => {
          this._metaStat.inTx--;
          if (x.readme) delete x.readme; // don't need this
          updateItem(x._cached ? "cached" : "200");
        })
        .catch(err => {
          const display = `failed fetching packument of ${pkgName}`;
          logger.error(chalk.yellow(display), chalk.red(err.message));
        });
    };

    this._metaStat.wait--;
    this._metaStat.inTx++;

    this.updateFetchMetaStatus(false);

    const promise = qItem.item.urlType ? this.fetchUrlSemverMeta(qItem.item) : pacoteRequest();

    return promise
      .then(x => {
        const time = Date.now() - startTime;
        if (time > 20 * 1000) {
          logger.info(
            chalk.red("Fetch meta of package"),
            logFormat.pkgId(qItem.item),
            `took ${logFormat.time(time)}!!!`
          );
        }
        qItem.defer.resolve(x);
      })
      .catch(err => {
        qItem.defer.reject(err);
      });
  }

  hasMeta(item) {
    return Boolean(this._meta[item.name]);
  }

  pkgPreperInstallDep(dir, displayTitle) {
    const node = process.env.NODE || process.execPath;
    const fyn = Path.join(__dirname, "../bin/fyn.js");
    return new VisualExec({
      displayTitle,
      cwd: dir,
      command: `${node} ${fyn} --pg simple -q v install --no-production`,
      visualLogger: logger
    }).execute();
  }

  _getPacoteDirPacker() {
    const pkgPrep = new PkgPreper({
      tmpDir: this._cacheDir,
      installDependencies: this.pkgPreperInstallDep
    });
    return pkgPrep.getDirPackerCb();
  }

  _packDir(manifest, dir) {
    return this._getPacoteDirPacker()(manifest, dir);
  }

  fetchUrlSemverMeta(item) {
    let dirPacker;

    if (item.urlType.startsWith("git")) {
      //
      // pacote's implementation of this is not ideal. It always want to
      // clone and pack the dir for manifest or tarball.
      //
      // So, in the latest npm (as of 6.4.0), it ends up doing twice a full
      // git clone, install dependencies, pack to tgz, and cache the result.
      //
      // Even with package-lock.json, npm still ends up cloning the repo and
      // install dependencies to pack tgz, despite that tgz may be in cache already.
      //
      // To make this more efficient, fyn use pacote only for figuring out
      // git and clone the package.
      // Then it moves the cloned dir away for its own use, and throw an
      // exception to make pacote bail out.
      //
      // To figure out the HEAD commit hash, pacote still ends up having to
      // clone the repo because looks like github doesn't set HEAD ref
      // for default branch.  So ls-remote doesn't have the HEAD symref.
      //
      // Ideally, it'd be nice if pacote has API to return the resolved URL first
      // before doing a git clone, so we can lookup from cache with it.
      // however, sometimes a clone is required to find the default branch from github.
      // maybe use github API to find default branch.
      // also, should check if there's only one branch and use that automatically.
      //
      dirPacker = (manifest, dir) => {
        const err = new Error("interrupt pacote");
        const capDir = `${dir}-fyn`;
        return Fs.rename(dir, capDir).then(() => {
          err.capDir = capDir;
          err.manifest = manifest;
          throw err;
        });
      };
    } else {
      dirPacker = this._getPacoteDirPacker();
    }

    return pacote
      .manifest(`${item.name}@${item.semver}`, this.getPacoteOpts({ dirPacker }))
      .then(manifest => {
        manifest = Object.assign({}, manifest);
        return {
          name: item.name,
          versions: {
            [manifest.version]: manifest
          },
          urlVersions: {
            [item.semver]: manifest
          }
        };
      })
      .catch(err => {
        if (!err.capDir) throw err;
        return this._prepPkgDirForManifest(item, err.manifest, err.capDir);
      });
  }

  async _prepPkgDirForManifest(item, manifest, dir) {
    //
    // The full git url with commit hash should be available in manifest._resolved
    // use that as cache key to lookup cached manifest
    //
    const tgzCacheKey = `fyn-tarball-for-${manifest._resolved}`;
    const tgzCacheInfo = await cacache.get.info(this._cacheDir, tgzCacheKey);

    let pkg;
    let integrity;

    if (tgzCacheInfo) {
      // found cache
      pkg = tgzCacheInfo.metadata;
      integrity = tgzCacheInfo.integrity;
      logger.debug("gitdep package", pkg.name, "found cache for", manifest._resolved);
    } else {
      //
      // prepare and pack dir into tgz
      //
      const packStream = this._packDir(manifest, dir);
      await new Promise((resolve, reject) => {
        packStream.on("prepared", resolve);
        packStream.on("error", reject);
      });
      pkg = await readPkgJson(dir);
      logger.debug("gitdep package", pkg.name, "prepared", manifest._resolved);
      //
      // cache tgz
      //
      const cacheStream = cacache.put.stream(this._cacheDir, tgzCacheKey, { metadata: pkg });
      cacheStream.on("integrity", i => (integrity = i.sha512[0].source));
      await pipe(
        packStream,
        cacheStream
      );
      logger.debug("gitdep package", pkg.name, "cached with integrity", integrity);
    }

    // embed info into tarball URL as a JSON string
    const tarball = JSON.stringify(
      Object.assign(_.pick(item, ["urlType", "semver"]), _.pick(manifest, ["_resolved", "_id"]))
    );

    manifest = Object.assign(
      {},
      pkg,
      _.pick(manifest, ["_resolved", "_integrity", "_shasum", "_id"]),
      {
        dist: {
          integrity,
          tarball: `${MARK_URL_SPEC}${tarball}`
        }
      }
    );

    await Fs.$.rimraf(dir);

    return {
      name: item.name,
      versions: {
        [manifest.version]: manifest
      },
      urlVersions: {
        [item.semver]: manifest
      }
    };
  }

  fetchMeta(item) {
    const pkgName = item.name;
    const pkgKey = `${pkgName}@${item.urlType ? item.urlType : "semver"}`;

    if (this._meta[pkgKey]) {
      return Promise.resolve(this._meta[pkgKey]);
    }

    const inflight = this._inflights.meta.get(pkgKey);
    if (inflight) {
      return inflight;
    }

    const queueMetaFetchRequest = cached => {
      const rd = this._fyn.remoteMetaDisabled;

      if (this._fyn.forceCache) {
        this._metaStat.wait--;
        return cached;
      }

      if (rd) {
        this._metaStat.wait--;
        if (cached) return cached;
        const msg = `option ${rd} has disabled retrieving meta from remote`;
        logger.error(`fetch meta for ${chalk.magenta(pkgName)} error:`, chalk.red(msg));
        throw new Error(msg);
      }

      this.updateFetchMetaStatus(false);

      const netQItem = {
        type: "meta",
        item,
        defer: createDefer()
      };

      this._netQ.addItem(netQItem);
      return netQItem.defer.promise;
    };

    let foundCache;

    this._metaStat.wait++;

    // first ask pacote to get packument from cache
    // TODO: pass in offline/prefer-offline/prefer-online flags to pacote so it can
    // handle these directly.
    const promise = pacote
      .packument(
        pkgName,
        this.getPacoteOpts({
          offline: true,
          "full-metadata": true,
          "fetch-retries": 3
        })
      )
      .then(cached => {
        foundCache = true;
        logger.debug("found", pkgName, "packument cache");
        return queueMetaFetchRequest(cached);
      })
      .catch(err => {
        if (foundCache) throw err;
        return queueMetaFetchRequest();
      })
      .then(meta => {
        this._metaStat.done++;
        this._meta[pkgKey] = meta;
        return meta;
      })
      .finally(() => {
        this._inflights.meta.remove(pkgKey);
      });

    return this._inflights.meta.add(pkgKey, promise);
  }

  pacotePrefetch(pkgId, integrity) {
    const stream = this.pacoteTarballStream(pkgId, integrity);

    const defer = createDefer();
    stream.once("end", () => {
      stream.destroy();
      defer.resolve();
    });
    stream.once("error", defer.reject);
    stream.on("data", _.noop);

    return defer.promise;
  }

  cacacheTarballStream(integrity) {
    return cacache.get.stream.byDigest(this._cacheDir, integrity);
  }

  pacoteTarballStream(pkgId, integrity) {
    return pacote.tarball.stream(pkgId, this.getPacoteOpts({ integrity }));
  }

  getIntegrity(item) {
    const integrity = _.get(item, "dist.integrity");
    if (integrity) return integrity;

    const shasum = _.get(item, "dist.shasum");

    if (shasum) {
      const b64 = Buffer.from(shasum, "hex").toString("base64");
      return `sha1-${b64}`;
    }

    return undefined;
  }

  tarballFetchId(pkgInfo) {
    const di = pkgInfo[DEP_ITEM];
    if (di && di.urlType) return `${di.name}@${di.semver}`;

    return `${pkgInfo.name}@${pkgInfo.version}`;
  }

  async getCentralPackage(integrity, pkgId) {
    const central = this._fyn.central;

    const tarStream = () => {
      return integrity
        ? this.cacacheTarballStream(integrity)
        : this.pacoteTarballStream(pkgId, integrity);
    };

    if (central) {
      const hasCentral = await central.has(integrity);
      if (!hasCentral) {
        logger.debug("storing tar to central store", pkgId, integrity);

        await central.storeTarStream(integrity, tarStream);
      }

      return integrity;
    }

    return tarStream();
  }

  fetchTarball(pkgInfo) {
    const startTime = Date.now();
    const pkgId = this.tarballFetchId(pkgInfo);
    const integrity = this.getIntegrity(pkgInfo);

    const doFetch = () => {
      const fetchStartTime = Date.now();

      if (!this._fetching) {
        this._fetching = [];
        this._fetchingMsg = "waiting...";
      }

      this._fetching.push(pkgId);

      logger.updateItem(FETCH_PACKAGE, `${this._fetching.length} ${this._fetchingMsg}`);

      return this.pacotePrefetch(pkgId, integrity).then(() => {
        const status = chalk.cyan(`200`);
        const time = logFormat.time(Date.now() - fetchStartTime);
        const ix = this._fetching.indexOf(pkgId);
        this._fetching.splice(ix, 1);
        this._fetchingMsg = `${status} ${time} ${chalk.red.bgGreen(pkgInfo.name)}`;
        logger.updateItem(FETCH_PACKAGE, `${this._fetching.length} ${this._fetchingMsg}`);
        return this.getCentralPackage(integrity, pkgId);
      });
    };

    // - check cached tarball with manifest._integrity
    // - use stream from cached tarball if exist
    // - else fetch from network

    const promise = cacache.get.hasContent(this._cacheDir, integrity).then(content => {
      if (content) {
        return this.getCentralPackage(integrity, pkgId);
      }

      const rd = this._fyn.remoteTgzDisabled;
      if (rd) {
        throw new Error(`option ${rd} has disabled retrieving tarball from remote`);
      }
      return doFetch();
    });

    return {
      then: (r, e) => promise.then(r, e),
      catch: e => promise.catch(e),
      tap: f => promise.tap(f),
      promise,
      startTime
    };
  }
}

module.exports = PkgSrcManager;
