import {extname, resolve} from "node:path/posix";
import {nodeResolve} from "@rollup/plugin-node-resolve";
import {simple} from "acorn-walk";
import {build} from "esbuild";
import type {AstNode, OutputChunk, Plugin, ResolveIdResult} from "rollup";
import {rollup} from "rollup";
import esbuild from "rollup-plugin-esbuild";
import {getClientPath, getStylePath} from "./files.js";
import {annotatePath} from "./javascript/annotate.js";
import type {StringLiteral} from "./javascript/source.js";
import {getStringLiteralValue, isStringLiteral} from "./javascript/source.js";
import {resolveNpmImport} from "./npm.js";
import {getObservableUiOrigin} from "./observableApiClient.js";
import {isAssetPath, isPathImport, relativePath} from "./path.js";
import {builtins} from "./resolvers.js";
import {Sourcemap} from "./sourcemap.js";
import {THEMES, renderTheme} from "./theme.js";

/**
 * 样式模块映射表
 * 将 observablehq: 协议的样式导入映射到实际的文件路径
 */
const STYLE_MODULES = {
  "observablehq:default.css": getStylePath("default.css"),
  ...Object.fromEntries(THEMES.map(({name, path}) => [`observablehq:theme-${name}.css`, path]))
};

/**
 * 需要被内联打包的模块列表
 * 这些模块不会被标记为外部依赖，而是会被直接打包到输出文件中
 */
// These libraries are currently bundled in to a wrapper.
const BUNDLED_MODULES = [
  "@observablehq/inputs", // observablehq:stdlib/inputs.js
  "@observablehq/inspector", // observablehq:runtime.js
  "@observablehq/runtime", // observablehq:runtime.js
  "isoformat", // observablehq:runtime.js
  "minisearch" // observablehq:search.js
];

/**
 * 重写 Inputs 组件的命名空间
 * 
 * 将 Observable Inputs 库中的 __ns__ 占位符替换为唯一的命名空间标识符
 * 避免与其他库的样式冲突
 * 
 * @param code - 需要处理的代码字符串
 * @returns 替换命名空间后的代码
 */
function rewriteInputsNamespace(code: string) {
  return code.replace(/\b__ns__\b/g, "inputs-3a86ea");
}

/**
 * 打包 CSS 样式文件
 * 
 * 使用 esbuild 将 CSS 文件打包，支持主题合并和压缩优化
 * 
 * @param options - 打包选项
 * @param options.minify - 是否压缩 CSS (默认: false)
 * @param options.path - CSS 文件路径，优先级高于 theme
 * @param options.theme - 主题名称数组，用于合并多个主题
 * 
 * @returns Promise<string> - 打包后的 CSS 代码
 * 
 * @example
 * // 打包单个样式文件
 * const css = await bundleStyles({
 *   path: "src/style/default.css",
 *   minify: true
 * });
 * 
 * @example 
 * // 合并多个主题
 * const css = await bundleStyles({
 *   theme: ["air", "ocean-floor", "wide"],
 *   minify: true
 * });
 */
export async function bundleStyles({
  minify = false,
  path,
  theme
}: {
  minify?: boolean;
  path?: string;
  theme?: string[];
}): Promise<string> {
  const result = await build({
    bundle: true,
    ...(path ? {entryPoints: [path]} : {stdin: {contents: renderTheme(theme!), loader: "css"}}),
    write: false,
    minify,
    alias: STYLE_MODULES
  });
  let text = result.outputFiles[0].text;
  if (path === getClientPath("stdlib/inputs.css")) text = rewriteInputsNamespace(text);
  return text;
}

/**
 * 导入解析器函数类型
 * 接收一个模块说明符，返回解析后的路径或 undefined（如果无法解析）
 */
type ImportResolver = (specifier: string) => Promise<string | undefined> | string | undefined;

/**
 * 使用 Rollup 打包 Observable Framework 的客户端 JavaScript 模块
 * 
 * 这个函数主要用于：
 * 1. 将 Framework 源代码 (src/client/) 打包为可在浏览器中运行的模块
 * 2. 处理模块依赖解析，包括 npm 包、内置模块和本地文件
 * 3. 进行代码转译、压缩和优化
 * 4. 解析 import.meta.resolve() 调用为实际的路径
 * 
 * @param input - 入口文件的路径
 *                例如: "src/client/index.js" (对应 /_observablehq/client.js)
 *                     "src/client/stdlib/inputs.js" (对应 /_observablehq/stdlib/inputs.js)
 *                用于指定 Rollup 从哪个文件开始打包
 * 
 * @param root - 项目根目录的路径
 *               例如: "/path/to/project" 或 "src"
 *               用于解析相对路径和模块依赖，特别是 npm 包的缓存位置
 * 
 * @param path - 目标模块的服务路径
 *               例如: "/_observablehq/client.js"
 *                    "/_observablehq/stdlib/inputs.js"
 *               用于计算相对路径，确保打包后的模块能正确引用其他资源
 * 
 * @param options - 打包选项配置对象
 * @param options.define - 编译时常量替换对象
 *                        例如: {"DUCKDB_MANIFEST": JSON.stringify(manifest)}
 *                        用于在打包时将代码中的常量替换为实际值
 * 
 * @param options.keepNames - 是否保留函数和类的名称 (默认: undefined)
 *                           在压缩代码时保留原始名称，便于调试
 *                           通常在生产构建时设为 true
 * 
 * @param options.minify - 是否压缩代码 (默认: undefined)
 *                        移除空白字符、缩短变量名等优化
 *                        开发模式通常为 false，构建模式为 true
 * 
 * @param options.resolveImport - 自定义的导入解析器函数 (默认: getDefaultResolver(root))
 *                               接收 import 说明符，返回解析后的路径
 *                               用于处理特殊的导入协议如 "observablehq:", "npm:" 等
 * 
 * @returns Promise<string> - 打包后的 JavaScript 代码字符串
 *                           可以直接写入文件或通过 HTTP 响应发送给客户端
 * 
 * @example
 * // 开发模式打包客户端代码
 * const code = await rollupClient(
 *   "src/client/preview.js",
 *   "/project/root", 
 *   "/_observablehq/client.js"
 * );
 * 
 * @example
 * // 生产构建打包标准库
 * const code = await rollupClient(
 *   "src/client/stdlib.js",
 *   "/project/root",
 *   "/_observablehq/stdlib.js",
 *   { minify: true, keepNames: true }
 * );
 * 
 * @example
 * // 打包 DuckDB 模块并注入清单
 * const code = await rollupClient(
 *   "src/client/stdlib/duckdb.js",
 *   "/project/root",
 *   "/_observablehq/stdlib/duckdb.js",
 *   { 
 *     define: { "DUCKDB_MANIFEST": JSON.stringify(manifest) },
 *     minify: true 
 *   }
 * );
 */
export async function rollupClient(
  input: string,
  root: string,
  path: string,
  {
    define,
    keepNames,
    minify,
    resolveImport = getDefaultResolver(root)
  }: {define?: {[key: string]: string}; keepNames?: boolean; minify?: boolean; resolveImport?: ImportResolver} = {}
): Promise<string> {
  if (typeof resolveImport !== "function") throw new Error(`invalid resolveImport: ${resolveImport}`);
  const bundle = await rollup({
    input,
    external: [/^https:/],
    plugins: [
      nodeResolve({resolveOnly: BUNDLED_MODULES}),
      importResolve(input, path, resolveImport),
      esbuild({
        format: "esm",
        platform: "browser",
        target: ["es2022", "chrome96", "firefox96", "safari16", "node18"],
        exclude: [], // don't exclude node_modules
        keepNames,
        minify,
        define: {
          "process.env.OBSERVABLE_ORIGIN": JSON.stringify(String(getObservableUiOrigin()).replace(/\/$/, "")),
          ...define
        }
      }),
      importMetaResolve(path, resolveImport)
    ],
    onwarn(message, warn) {
      if (message.code === "CIRCULAR_DEPENDENCY") return;
      warn(message);
    }
  });
  try {
    const output = await bundle.generate({format: "es"});
    const code = output.output.find((o): o is OutputChunk => o.type === "chunk")!.code; // TODO don't assume one chunk?
    return rewriteTypeScriptImports(code);
  } finally {
    await bundle.close();
  }
}

/**
 * 修复 TypeScript 导入路径问题
 * 
 * Rollup 在处理相对导入时，如果发现 .ts 文件存在，会自动将 .js 导入重写为 .ts
 * 但在运行时只有 .js 文件存在，所以需要将导入路径改回 .js
 * 这是一个针对 Rollup/esbuild 行为的临时修复
 * 
 * @param code - 需要处理的 JavaScript 代码
 * @returns 修复后的代码，所有动态导入中的 .ts 扩展名都被替换为 .js
 * 
 * @see https://github.com/observablehq/framework/issues/478
 */
// For reasons not entirely clear (to me), when we resolve a relative import to
// a TypeScript file, such as resolving observablehq:stdlib/foo to
// ./src/client/stdlib/foo.js, Rollup (or rollup-plugin-esbuild?) notices that
// there is a foo.ts and rewrites the import to foo.ts. But the imported file at
// runtime won't be TypeScript and will only exist at foo.js, so here we rewrite
// the import back to what it was supposed to be. This is a dirty hack but it
// gets the job done. 🤷 https://github.com/observablehq/framework/issues/478
function rewriteTypeScriptImports(code: string): string {
  return code.replace(/(?<=\bimport\(([`'"])[\w./]+)\.ts(?=\1\))/g, ".js");
}

/**
 * 获取默认的导入解析器
 * 
 * @param root - 项目根目录，用于解析 npm 包等依赖
 * @returns 导入解析器函数
 */
function getDefaultResolver(root: string): ImportResolver {
  return (specifier: string) => resolveImport(root, specifier);
}

/**
 * 解析模块导入说明符为实际的文件路径
 * 
 * 处理不同类型的导入协议：
 * - BUNDLED_MODULES: 返回 undefined (将被内联打包)
 * - builtins: Framework 内置模块映射
 * - "observablehq:": Framework 协议导入
 * - "npm:": npm 包导入
 * - 裸导入 (无协议): 作为 npm 包处理
 * - 其他: 返回 undefined (保持原样)
 * 
 * @param root - 项目根目录
 * @param specifier - 导入说明符，如 "observablehq:stdlib", "npm:d3", "react" 等
 * @returns 解析后的路径或 undefined
 * 
 * @example
 * await resolveImport("/project", "observablehq:stdlib")
 * // => "/_observablehq/stdlib.js"
 * 
 * @example
 * await resolveImport("/project", "npm:d3")
 * // => "/_npm/d3@7.8.5/+esm"
 */
export async function resolveImport(root: string, specifier: string): Promise<string | undefined> {
  return BUNDLED_MODULES.includes(specifier)
    ? undefined
    : builtins.has(specifier)
    ? builtins.get(specifier)
    : specifier.startsWith("observablehq:")
    ? `/_observablehq/${specifier.slice("observablehq:".length)}${extname(specifier) ? "" : ".js"}`
    : specifier.startsWith("npm:")
    ? await resolveNpmImport(root, specifier.slice("npm:".length))
    : !/^[a-z]:\\/i.test(specifier) && !isPathImport(specifier)
    ? await resolveNpmImport(root, specifier)
    : undefined;
}

/**
 * Rollup 插件：解析导入语句
 * 
 * 这个插件拦截 Rollup 的模块解析过程，使用自定义的 resolveImport 函数
 * 来处理特殊的导入协议（如 observablehq:, npm: 等）
 * 
 * @param input - 入口文件的绝对路径
 * @param path - 目标模块的服务路径
 * @param resolveImport - 自定义导入解析器函数
 * @returns Rollup 插件对象
 */
function importResolve(input: string, path: string, resolveImport: ImportResolver): Plugin {
  input = resolve(input);

  async function resolveId(specifier: string | AstNode): Promise<ResolveIdResult> {
    if (typeof specifier !== "string") return null;
    if (isAssetPath(specifier) && resolve(specifier) === input) return null;
    const resolution = await resolveImport(specifier);
    if (resolution) return {id: relativePath(path, resolution), external: true};
    return null;
  }

  return {
    name: "resolve-import",
    resolveId,
    resolveDynamicImport: resolveId
  };
}

/**
 * Rollup 插件：解析 import.meta.resolve() 调用
 * 
 * 这个插件在代码转换阶段，找到所有的 import.meta.resolve() 调用，
 * 并将其中的模块说明符解析为实际的路径
 * 
 * @param path - 目标模块的服务路径
 * @param resolveImport - 自定义导入解析器函数
 * @returns Rollup 插件对象
 * 
 * @example
 * // 转换前
 * const url = import.meta.resolve("observablehq:stdlib");
 * 
 * // 转换后  
 * const url = "./_observablehq/stdlib.js";
 */
function importMetaResolve(path: string, resolveImport: ImportResolver): Plugin {
  return {
    name: "resolve-import-meta-resolve",
    async transform(code) {
      const program = this.parse(code);
      const resolves: StringLiteral[] = [];

      simple(program, {
        CallExpression(node) {
          if (
            node.callee.type === "MemberExpression" &&
            node.callee.object.type === "MetaProperty" &&
            node.callee.property.type === "Identifier" &&
            node.callee.property.name === "resolve" &&
            node.arguments.length === 1 &&
            isStringLiteral(node.arguments[0])
          ) {
            resolves.push(node.arguments[0]);
          }
        }
      });

      if (!resolves.length) return null;

      const output = new Sourcemap(code);
      for (const source of resolves) {
        const specifier = getStringLiteralValue(source);
        const resolution = await resolveImport(specifier);
        if (resolution) output.replaceLeft(source.start, source.end, annotatePath(relativePath(path, resolution)));
      }

      return {code: String(output)};
    }
  };
}
