// @ts-expect-error lineBreakG is private
import {lineBreakG} from "acorn";

/**
 * 代码编辑操作的数据结构
 * 描述了在原始代码中的某个位置进行的替换操作
 */
interface Edit {
  value: string; // 替换后的新值
  start: number; // 替换开始位置（字符索引）
  end: number;   // 替换结束位置（字符索引）
}

/**
 * 代码位置信息（行列坐标）
 */
interface Position {
  line: number;   // 行号（从1开始）
  column: number; // 列号（从0开始）
}

/**
 * Sourcemap 类 - 代码转换和编辑工具
 * 
 * 这个类的主要作用是：
 * 1. 对原始代码进行非破坏性的编辑操作（插入、删除、替换）
 * 2. 维护代码转换过程中的位置映射关系
 * 3. 支持增量式的代码修改，可以进行多次编辑操作
 * 4. 在代码转换完成后生成最终的代码字符串
 * 
 * 主要应用场景：
 * - 代码转译过程中的 AST 节点替换
 * - import.meta.resolve() 调用的路径解析和替换
 * - 模块导入路径的重写
 * - 代码注入和修改
 * 
 * 设计特点：
 * - 延迟执行：所有编辑操作都被记录但不立即执行
 * - 冲突处理：自动处理重叠的编辑区域
 * - 位置追踪：可以将输出位置映射回原始代码位置
 * 
 * @example
 * const sm = new Sourcemap('console.log("hello");');
 * sm.replaceLeft(0, 7, 'alert'); // 将 console 替换为 alert  
 * console.log(sm.toString()); // 'alert.log("hello");'
 */
export class Sourcemap {
  /** 原始输入代码 */
  readonly input: string;
  /** 编辑操作列表，按开始位置排序 */
  private readonly _edits: Edit[];

  /**
   * 创建一个新的 Sourcemap 实例
   * @param input - 原始代码字符串
   */
  constructor(input: string) {
    this.input = input;
    this._edits = [];
  }

  /**
   * 二分查找：找到第一个开始位置 >= index 的编辑操作
   * @param index - 查找的位置索引
   * @returns 编辑操作在数组中的插入位置
   */
  private _bisectLeft(index: number): number {
    let lo = 0;
    let hi = this._edits.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._edits[mid].start < index) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 二分查找：找到第一个开始位置 > index 的编辑操作
   * @param index - 查找的位置索引  
   * @returns 编辑操作在数组中的插入位置
   */
  private _bisectRight(index: number): number {
    let lo = 0;
    let hi = this._edits.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._edits[mid].start > index) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /**
   * 移除被新编辑操作完全包含的旧编辑操作
   * 当添加一个新的编辑操作时，需要删除所有被它完全覆盖的旧操作
   * @param start - 新编辑操作的开始位置
   * @param end - 新编辑操作的结束位置
   */
  private _subsume(start: number, end: number): void {
    let n = 0;
    for (let i = 0; i < this._edits.length; ++i) {
      const e = this._edits[i];
      if (start <= e.start && e.end < end) continue; // 被新操作完全包含，跳过
      this._edits[n++] = e;
    }
    this._edits.length = n;
  }

  /**
   * 在指定位置的左侧插入文本
   * @param index - 插入位置
   * @param value - 要插入的文本
   * @returns this（支持链式调用）
   */
  insertLeft(index: number, value: string): typeof this {
    return this.replaceLeft(index, index, value);
  }

  /**
   * 在指定位置的右侧插入文本
   * @param index - 插入位置
   * @param value - 要插入的文本
   * @returns this（支持链式调用）
   */
  insertRight(index: number, value: string): typeof this {
    return this.replaceRight(index, index, value);
  }

  /**
   * 删除指定范围的文本
   * @param start - 删除开始位置
   * @param end - 删除结束位置
   * @returns this（支持链式调用）
   */
  delete(start: number, end: number): typeof this {
    return this.replaceRight(start, end, "");
  }

  /**
   * 替换指定范围的文本（优先插入到左侧）
   * 当多个编辑操作在同一位置时，左侧替换会排在前面
   * @param start - 替换开始位置
   * @param end - 替换结束位置  
   * @param value - 新的文本内容
   * @returns this（支持链式调用）
   */
  replaceLeft(start: number, end: number, value: string): typeof this {
    this._subsume(start, end);
    this._edits.splice(this._bisectLeft(start), 0, {start, end, value});
    return this;
  }

  /**
   * 替换指定范围的文本（优先插入到右侧）
   * 当多个编辑操作在同一位置时，右侧替换会排在后面
   * @param start - 替换开始位置
   * @param end - 替换结束位置
   * @param value - 新的文本内容
   * @returns this（支持链式调用）
   */
  replaceRight(start: number, end: number, value: string): typeof this {
    this._subsume(start, end);
    this._edits.splice(this._bisectRight(start), 0, {start, end, value});
    return this;
  }

  /**
   * 将输出代码中的位置映射回原始代码中的位置
   * 这对于错误报告和调试非常有用，可以追踪转换后的代码位置对应的原始位置
   * @param position - 输出代码中的位置（行列坐标）
   * @returns 对应的原始代码位置
   */
  translate(position: Position): Position {
    let index = 0;
    let ci: Position = {line: 1, column: 0}; // 输入位置
    let co: Position = {line: 1, column: 0}; // 输出位置
    for (const {start, end, value} of this._edits) {
      if (start > index) {
        const l = positionLength(this.input, index, start);
        const ci2 = positionAdd(ci, l);
        const co2 = positionAdd(co, l);
        if (positionCompare(co2, position) > 0) break;
        ci = ci2;
        co = co2;
      }
      const il = positionLength(this.input, start, end);
      const ol = positionLength(value);
      const ci2 = positionAdd(ci, il);
      const co2 = positionAdd(co, ol);
      if (positionCompare(co2, position) > 0) return ci;
      ci = ci2;
      co = co2;
      index = end;
    }
    const l = positionSubtract(position, co);
    return positionAdd(ci, l);
  }

  /**
   * 修剪代码首尾的换行符
   * @returns this（支持链式调用）
   */
  trim(): typeof this {
    const input = this.input;
    if (input.startsWith("\n")) this.delete(0, 1); // TODO better trim
    if (input.endsWith("\n")) this.delete(input.length - 1, input.length); // TODO better trim
    return this;
  }

  /**
   * 生成最终的代码字符串
   * 应用所有编辑操作，生成转换后的代码
   * @returns 转换后的代码字符串
   */
  toString(): string {
    let output = "";
    let index = 0;
    // 按顺序应用所有编辑操作
    for (const {start, end, value} of this._edits) {
      if (start > index) output += this.input.slice(index, start); // 复制未修改的部分
      output += value; // 添加替换内容
      index = end;     // 跳过被替换的部分
    }
    output += this.input.slice(index); // 添加剩余的未修改部分
    return output;
  }
}

/**
 * 比较两个位置的大小关系
 * @param a - 第一个位置
 * @param b - 第二个位置  
 * @returns 负数表示 a < b，0 表示 a == b，正数表示 a > b
 */
function positionCompare(a: Position, b: Position): number {
  return a.line - b.line || a.column - b.column;
}

/**
 * 计算字符串指定范围的位置长度（行列坐标差值）
 * @param input - 输入字符串
 * @param start - 开始位置（字符索引，默认为0）
 * @param end - 结束位置（字符索引，默认为字符串末尾）
 * @returns 位置长度，包含行数和列数的偏移量
 */
function positionLength(input: string, start = 0, end = input.length): Position {
  let match: RegExpExecArray;
  let line = 0;
  lineBreakG.lastIndex = start;
  // 计算指定范围内的换行符数量
  while ((match = lineBreakG.exec(input)) && match.index < end) {
    ++line;
    start = match.index + match[0].length;
  }
  return {line, column: end - start};
}

/**
 * 计算两个位置的差值
 * @param b - 被减数位置
 * @param a - 减数位置
 * @returns 位置差值
 */
function positionSubtract(b: Position, a: Position): Position {
  return b.line === a.line ? {line: 0, column: b.column - a.column} : {line: b.line - a.line, column: b.column};
}

/**
 * 将位置偏移量添加到基准位置
 * @param p - 基准位置
 * @param l - 位置偏移量
 * @returns 新的位置
 */
function positionAdd(p: Position, l: Position): Position {
  return l.line === 0 ? {line: p.line, column: p.column + l.column} : {line: p.line + l.line, column: l.column};
}
