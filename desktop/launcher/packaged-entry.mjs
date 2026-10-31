// The Electron shell owns identity; all executable product code lives in one
// real resource tree so Node/Python children never receive an ASAR-only path.
import {app} from 'electron';
import {dispatchPackagedApplication} from '../agent-runtime/desktop/launcher/component-dispatch.mjs';
try{await dispatchPackagedApplication();}
catch(error){process.stderr.write('组件入口未完成核对：'+error.message+'\n');app.exit(1);}
