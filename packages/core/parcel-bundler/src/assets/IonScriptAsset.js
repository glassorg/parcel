const Asset = require('../Asset');
const localRequire = require('../utils/localRequire');
const isAccessedVarChanged = require('../utils/isAccessedVarChanged');

class IonScriptAsset extends Asset {
  constructor(name, options) {
    super(name, options);
    this.type = 'js';
    this.cacheData.env = {};
  }

  shouldInvalidate(cacheData) {
    return isAccessedVarChanged(cacheData);
  }

  async generate() {
    let {compileSingle} = await localRequire(
      'ionscript/lib/compiler/Compiler',
      this.name
    );
    let debug = this.options.production === false;
    let result = compileSingle(this.contents, this.name, debug, '.js');
    if (result.error) {
      throw result.error;
    }

    return [
      {
        type: 'js',
        value: result.output
      }
    ];
  }
}

module.exports = IonScriptAsset;
