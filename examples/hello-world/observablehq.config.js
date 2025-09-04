import {ProxyAgent, setGlobalDispatcher} from "undici";

const proxyAgent = new ProxyAgent({uri: "http://10.1.128.235:3128"});
setGlobalDispatcher(proxyAgent)
export default {
  root: "src"
};
