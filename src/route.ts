/**
 * Observable Framework 动态路由系统
 * 
 * 这个模块实现了 Observable Framework 的核心路由系统，支持参数化路径和动态路由。
 * 它是数据加载器、页面加载器和静态资源解析的基础。
 * 
 * 核心功能：
 * 1. **参数化路径识别**: 识别包含 [param] 格式的路径模式
 * 2. **动态路由匹配**: 将具体路径匹配到参数化模板
 * 3. **参数提取**: 从匹配的路径中提取参数值
 * 4. **优先级处理**: 精确匹配优先于参数化匹配
 * 5. **多扩展名支持**: 支持多种文件扩展名的匹配
 * 
 * 使用场景：
 * - 页面路由：/products/[id].md → /products/123
 * - 数据加载器：/data/[year]/[month].csv → /data/2023/01.csv
 * - 静态资源：/assets/[category]/[name].png → /assets/icons/home.png
 * - API 端点：/api/[version]/[resource] → /api/v1/users
 * 
 * 路径优先级（从高到低）：
 * 1. 精确匹配：/products/123.md
 * 2. 参数化文件：/products/[id].md
 * 3. 参数化目录：/[category]/123.md
 * 4. 多参数组合：/[category]/[id].md
 */

import {existsSync, statSync} from "node:fs";
import {basename, join} from "node:path/posix";
import {globSync} from "glob";

/**
 * 路由参数类型定义
 * 
 * 表示从参数化路径中提取的参数键值对
 * 
 * @example
 * ```typescript
 * // 路径: /products/[id].md, 匹配: /products/123.md
 * const params: Params = {id: "123"};
 * 
 * // 路径: /[year]/[month]/[day].md, 匹配: /2023/12/25.md
 * const params: Params = {year: "2023", month: "12", day: "25"};
 * ```
 */
export type Params = {[name: string]: string};

/**
 * 路由结果类型定义
 * 
 * 包含匹配到的文件路径、扩展名和提取的参数
 */
export type RouteResult = {
  /** 匹配到的文件相对路径 */
  path: string;
  /** 文件扩展名 */
  ext: string;
  /** 提取的参数（如果是参数化路径） */
  params?: Params;
};

/**
 * 判断路径名是否包含参数化模式
 * 
 * 检查文件或目录名是否包含 [paramName] 格式的参数占位符。
 * 参数名必须以字母或下划线开头，后跟字母、数字或下划线。
 * 
 * @param name 文件或目录名
 * @returns 是否为参数化路径
 * 
 * @example
 * ```typescript
 * // 参数化文件
 * isParameterized("[id].md") → true
 * isParameterized("product-[id].html") → true
 * isParameterized("[year]-[month]-[day].csv") → true
 * isParameterized("[category_id].json") → true
 * 
 * // 非参数化文件
 * isParameterized("index.md") → false
 * isParameterized("about.html") → false
 * isParameterized("data.csv") → false
 * 
 * // 无效的参数格式
 * isParameterized("[123].md") → false  // 参数名不能以数字开头
 * isParameterized("[param-name].md") → false  // 参数名不能包含连字符
 * isParameterized("[]].md") → false  // 空参数名
 * ```
 */
export function isParameterized(name: string): boolean {
  return /\[([a-z_]\w*)\]/i.test(name);
}

/**
 * 动态路由匹配的核心函数
 * 
 * 在指定根目录中查找与给定路径匹配的文件，支持多种扩展名和参数化路径。
 * 这是 Observable Framework 路由系统的入口函数。
 * 
 * 匹配策略：
 * 1. **精确匹配优先**: 先寻找完全匹配的文件
 * 2. **参数化匹配**: 然后寻找参数化模板文件
 * 3. **扩展名顺序**: 按提供的扩展名顺序进行匹配
 * 4. **目录递归**: 递归搜索嵌套的参数化目录
 * 
 * @param root 搜索的根目录路径
 * @param path 要匹配的目标路径（不含扩展名）
 * @param exts 候选扩展名数组，按优先级排序
 * @returns 匹配结果，包含文件路径、扩展名和参数
 * 
 * @example
 * ```typescript
 * // 文件结构:
 * // src/
 * // ├── products/
 * // │   ├── index.md
 * // │   ├── [id].md
 * // │   └── [id].csv.js
 * // └── [category]/
 * //     └── [item].md
 * 
 * // 精确匹配示例
 * route("src", "products/index", [".md"])
 * // → {path: "products/index.md", ext: ".md"}
 * 
 * // 参数化文件匹配
 * route("src", "products/123", [".md"])
 * // → {path: "products/[id].md", ext: ".md", params: {id: "123"}}
 * 
 * // 数据加载器匹配（多扩展名）
 * route("src", "products/456", [".csv", ".csv.js"])
 * // → {path: "products/[id].csv.js", ext: ".csv.js", params: {id: "456"}}
 * 
 * // 参数化目录匹配
 * route("src", "electronics/laptop", [".md"])
 * // → {path: "[category]/[item].md", ext: ".md", params: {category: "electronics", item: "laptop"}}
 * 
 * // 未找到匹配
 * route("src", "nonexistent/path", [".md"])
 * // → undefined
 * ```
 */
export function route(root: string, path: string, exts: string[]): RouteResult | undefined {
  return routeParams(root, ".", join(".", path).split("/"), exts);
}

/**
 * 递归路由参数匹配函数
 * 
 * 这是路由系统的核心递归函数，负责在目录树中查找最具体的匹配项。
 * 它处理路径的每个部分，支持嵌套的参数化目录和文件。
 * 
 * 算法逻辑：
 * 1. **终止条件**: 路径为空时停止递归
 * 2. **叶子节点**: 路径只有一个部分时，查找文件
 * 3. **目录节点**: 路径有多个部分时，递归处理子目录
 * 4. **精确优先**: 精确匹配的目录优先于参数化目录
 * 5. **参数合并**: 将各级目录的参数合并到最终结果
 * 
 * @param root 根目录绝对路径
 * @param cwd 当前工作目录（相对于根目录）
 * @param parts 剩余的路径部分数组
 * @param exts 候选扩展名数组
 * @returns 路由匹配结果
 * 
 * @example
 * ```typescript
 * // 文件结构:
 * // src/
 * // ├── api/
 * // │   ├── users.js
 * // │   └── [version]/
 * // │       └── [resource].js
 * // └── [category]/
 * //     ├── index.md
 * //     └── [id].md
 * 
 * // 精确目录 + 精确文件
 * routeParams("src", ".", ["api", "users"], [".js"])
 * // → {path: "api/users.js", ext: ".js"}
 * 
 * // 精确目录 + 参数化目录 + 参数化文件
 * routeParams("src", ".", ["api", "v1", "posts"], [".js"])
 * // → {path: "api/[version]/[resource].js", ext: ".js", params: {version: "v1", resource: "posts"}}
 * 
 * // 参数化目录 + 精确文件
 * routeParams("src", ".", ["products", "index"], [".md"])
 * // → {path: "[category]/index.md", ext: ".md", params: {category: "products"}}
 * 
 * // 参数化目录 + 参数化文件
 * routeParams("src", ".", ["electronics", "laptop-123"], [".md"])
 * // → {path: "[category]/[id].md", ext: ".md", params: {category: "electronics", id: "laptop-123"}}
 * ```
 */
function routeParams(root: string, cwd: string, parts: string[], exts: string[]): RouteResult | undefined {
  switch (parts.length) {
    case 0:
      return;
    case 1: {
      // 🎯 处理路径的最后一部分（文件名）
      const [first] = parts;
      
      // 📂 首先尝试精确匹配
      if (!isParameterized(first)) {
        for (const ext of exts) {
          const path = join(root, cwd, first + ext);
          if (existsSync(path)) {
            if (!statSync(path).isFile()) return; // 忽略非文件项
            return {path: join(cwd, first + ext), ext};
          }
        }
      }
      
      // 🔍 然后尝试参数化匹配
      if (first) {
        for (const ext of exts) {
          // 使用 glob 查找参数化文件模式：*[param]*ext
          for (const file of globSync(`*\\[?*\\]*${ext}`, {cwd: join(root, cwd), nodir: true})) {
            const params = matchParams(basename(file, ext), first);
            if (params) return {path: join(cwd, file), params: {...params}, ext};
          }
        }
      }
      return;
    }
    default: {
      // 🗂️ 处理多级路径（目录 + 子路径）
      const [first, ...rest] = parts;
      
      // 📁 首先尝试精确目录匹配
      const path = join(root, cwd, first);
      if (existsSync(path)) {
        if (!statSync(path).isDirectory()) return; // 忽略非目录项
        if (!isParameterized(first)) {
          const found = routeParams(root, join(cwd, first), rest, exts);
          if (found) return found;
        }
      }
      
      // 🔄 然后尝试参数化目录匹配
      if (first) {
        // 使用 glob 查找参数化目录模式：*[param]*/
        for (const dir of globSync("*\\[?*\\]*/", {cwd: join(root, cwd)})) {
          const params = matchParams(dir, first);
          if (!params) continue;
          
          // 递归搜索参数化目录中的子路径
          const found = routeParams(root, join(cwd, dir), rest, exts);
          if (found) {
            // 🔗 合并当前级别和子级别的参数
            return {...found, params: {...found.params, ...params}};
          }
        }
      }
    }
  }
}

/**
 * 参数匹配函数
 * 
 * 将参数化文件模式与具体输入进行匹配，提取参数值。
 * 使用编译后的正则表达式进行高效匹配。
 * 
 * @param file 参数化文件模式（如 "[id].md" 或 "product-[id]-[name].html"）
 * @param input 具体的输入值（如 "123.md" 或 "product-123-laptop.html"）
 * @returns 提取的参数对象，如果不匹配则返回 undefined
 * 
 * @example
 * ```typescript
 * // 简单参数匹配
 * matchParams("[id]", "123")
 * // → {id: "123"}
 * 
 * // 复合参数匹配
 * matchParams("[year]-[month]-[day]", "2023-12-25")
 * // → {year: "2023", month: "12", day: "25"}
 * 
 * // 前缀后缀匹配
 * matchParams("product-[id]-detail", "product-456-detail")
 * // → {id: "456"}
 * 
 * // 多个参数
 * matchParams("[category]_[subcategory]_[id]", "electronics_laptops_abc123")
 * // → {category: "electronics", subcategory: "laptops", id: "abc123"}
 * 
 * // 不匹配的情况
 * matchParams("[id]", "")
 * // → undefined
 * 
 * matchParams("product-[id]", "service-123")
 * // → undefined
 * ```
 */
function matchParams(file: string, input: string): Params | undefined {
  return compilePattern(file).exec(input)?.groups;
}

/**
 * 编译参数化模式为正则表达式
 * 
 * 将包含 [param] 占位符的模式字符串转换为可以匹配和提取参数的正则表达式。
 * 使用命名捕获组来提取参数值。
 * 
 * 编译过程：
 * 1. **转义字面量**: 转义模式中的特殊正则字符
 * 2. **参数替换**: 将 [param] 转换为命名捕获组 (?<param>.+)
 * 3. **锚定匹配**: 添加开始和结束锚点确保完全匹配
 * 
 * @param file 包含参数占位符的文件模式
 * @returns 编译后的正则表达式
 * 
 * @example
 * ```typescript
 * // 简单参数
 * compilePattern("[id]")
 * // → /^(?<id>.+)$/i
 * 
 * // 带前缀后缀
 * compilePattern("product-[id].html")
 * // → /^product-(?<id>.+)\.html$/i
 * 
 * // 多个参数
 * compilePattern("[year]-[month]-[day]")
 * // → /^(?<year>.+)-(?<month>.+)-(?<day>.+)$/i
 * 
 * // 复杂模式
 * compilePattern("api_v[version]_[resource]_[action].json")
 * // → /^api_v(?<version>.+)_(?<resource>.+)_(?<action>.+)\.json$/i
 * 
 * // 使用示例
 * const pattern = compilePattern("[category]-[id]");
 * const match = pattern.exec("electronics-laptop123");
 * // match.groups → {category: "electronics", id: "laptop123"}
 * ```
 */
function compilePattern(file: string): RegExp {
  let pattern = "^";  // 模式开始锚点
  let i = 0;          // 当前处理位置
  
  // 🔍 查找所有 [paramName] 模式
  for (let match: RegExpExecArray | null, re = /\[([a-z_]\w*)\]/gi; (match = re.exec(file)); i = re.lastIndex) {
    // 📝 添加参数前的字面量文本（转义特殊字符）
    pattern += `${requote(file.slice(i, match.index))}`;
    
    // 🎯 添加命名捕获组：(?<paramName>.+)
    pattern += `(?<${match[1]}>.+)`;
  }
  
  // 📝 添加最后的字面量文本和结束锚点
  pattern += `${requote(file.slice(i))}$`;
  
  // 🏗️ 创建大小写不敏感的正则表达式
  return new RegExp(pattern, "i");
}

/**
 * 转义正则表达式特殊字符
 * 
 * 将字符串中的正则表达式元字符进行转义，使其可以作为字面量在正则表达式中使用。
 * 这确保了文件名中的特殊字符（如点号、括号等）被正确处理。
 * 
 * @param text 需要转义的文本
 * @returns 转义后的文本
 * 
 * @example
 * ```typescript
 * // 点号转义（文件扩展名）
 * requote("file.txt") → "file\\.txt"
 * 
 * // 括号转义
 * requote("data(2023).csv") → "data\\(2023\\)\\.csv"
 * 
 * // 多种特殊字符
 * requote("api+v1.0*test?data") → "api\\+v1\\.0\\*test\\?data"
 * 
 * // 已经包含反斜杠的情况
 * requote("path\\to\\file") → "path\\\\to\\\\file"
 * 
 * // 正则字符类
 * requote("range[0-9]") → "range\\[0-9\\]"
 * 
 * // 在模式编译中的使用
 * compilePattern("prefix.data[id].suffix")
 * // 内部调用: requote("prefix.data") → "prefix\\.data"
 * // 最终模式: /^prefix\.data(?<id>.+)\.suffix$/i
 * ```
 */
export function requote(text: string): string {
  return text.replace(/[\\^$*+?|[\]().{}]/g, "\\$&");
}
