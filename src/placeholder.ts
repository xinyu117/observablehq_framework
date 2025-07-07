/**
 * HTML占位符解析器
 * 
 * 该模块实现了一个专门的HTML解析器，用于识别和提取HTML内容中的JavaScript表达式占位符。
 * 主要功能：
 * 1. 解析HTML标签和内容，正确处理各种HTML语法结构
 * 2. 识别 ${...} 形式的JavaScript表达式占位符
 * 3. 处理转义字符，支持 \${ 形式的转义
 * 4. 使用状态机确保在HTML标签内部不会误识别占位符
 * 5. 支持原始文本元素（script、style、textarea、title）的特殊处理
 * 
 * 解析过程：
 * - 使用有限状态机解析HTML结构
 * - 在数据状态下识别 ${...} 表达式
 * - 使用Acorn解析器验证JavaScript表达式的语法正确性
 * - 正确处理嵌套的大括号和模板字符串
 */

import {Parser, tokTypes} from "acorn";
import {acornOptions} from "./javascript/parse.js";

// ASCII字符码常量定义
// 这些常量用于高效的字符识别，避免字符串比较的性能开销
const CODE_TAB = 9,           // 制表符 \t
  CODE_LF = 10,               // 换行符 \n
  CODE_FF = 12,               // 换页符 \f
  CODE_CR = 13,               // 回车符 \r
  CODE_SPACE = 32,            // 空格
  CODE_UPPER_A = 65,          // 大写字母A
  CODE_UPPER_Z = 90,          // 大写字母Z
  CODE_LOWER_A = 97,          // 小写字母a
  CODE_LOWER_Z = 122,         // 小写字母z
  CODE_LT = 60,               // 小于号 <
  CODE_GT = 62,               // 大于号 >
  CODE_SLASH = 47,            // 斜杠 /
  CODE_DASH = 45,             // 连字符 -
  CODE_BANG = 33,             // 感叹号 !
  CODE_EQ = 61,               // 等号 =
  CODE_DQUOTE = 34,           // 双引号 "
  CODE_SQUOTE = 39,           // 单引号 '
  CODE_QUESTION = 63,         // 问号 ?
  CODE_DOLLAR = 36,           // 美元符号 $
  CODE_LBRACE = 123,          // 左大括号 {
  CODE_BACKSLASH = 92,        // 反斜杠 \

  // HTML解析器状态常量
  // 基于HTML5规范的标记化状态，简化版本专注于处理占位符需求
  STATE_DATA = 1,                                    // 数据状态：普通文本内容
  STATE_TAG_OPEN = 2,                               // 标签开始状态：遇到 <
  STATE_END_TAG_OPEN = 3,                           // 结束标签开始状态：遇到 </
  STATE_TAG_NAME = 4,                               // 标签名状态：正在读取标签名
  STATE_BOGUS_COMMENT = 5,                          // 伪注释状态：处理无效的注释语法
  STATE_BEFORE_ATTRIBUTE_NAME = 6,                  // 属性名前状态：标签名后的空白
  STATE_AFTER_ATTRIBUTE_NAME = 7,                   // 属性名后状态：属性名后可能有=
  STATE_ATTRIBUTE_NAME = 8,                         // 属性名状态：正在读取属性名
  STATE_BEFORE_ATTRIBUTE_VALUE = 9,                 // 属性值前状态：= 号后的空白
  STATE_ATTRIBUTE_VALUE_DOUBLE_QUOTED = 10,         // 双引号属性值状态："value"
  STATE_ATTRIBUTE_VALUE_SINGLE_QUOTED = 11,         // 单引号属性值状态：'value'
  STATE_ATTRIBUTE_VALUE_UNQUOTED = 12,              // 无引号属性值状态：value
  STATE_AFTER_ATTRIBUTE_VALUE_QUOTED = 13,          // 引号属性值后状态：引号关闭后
  STATE_SELF_CLOSING_START_TAG = 14,                // 自闭合标签状态：遇到 />
  STATE_COMMENT_START = 15,                         // 注释开始状态：<!
  STATE_COMMENT_START_DASH = 16,                    // 注释开始破折号状态：<!-
  STATE_COMMENT = 17,                               // 注释内容状态：<!-- content
  STATE_COMMENT_LESS_THAN_SIGN = 18,                // 注释中小于号状态：注释中的 <
  STATE_COMMENT_LESS_THAN_SIGN_BANG = 19,           // 注释中 <! 状态
  STATE_COMMENT_LESS_THAN_SIGN_BANG_DASH = 20,      // 注释中 <!- 状态
  STATE_COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH = 21, // 注释中 <!-- 状态
  STATE_COMMENT_END_DASH = 22,                      // 注释结束破折号状态：-
  STATE_COMMENT_END = 23,                           // 注释结束状态：--
  STATE_COMMENT_END_BANG = 24,                      // 注释结束感叹号状态：--!
  STATE_MARKUP_DECLARATION_OPEN = 25,               // 标记声明开始状态：<!
  STATE_RAWTEXT = 26,                               // 原始文本状态：script/style内容
  STATE_RAWTEXT_LESS_THAN_SIGN = 27,                // 原始文本中小于号状态
  STATE_RAWTEXT_END_TAG_OPEN = 28,                  // 原始文本结束标签开始状态
  STATE_RAWTEXT_END_TAG_NAME = 29;                  // 原始文本结束标签名状态

/**
 * 占位符令牌接口
 * 描述解析过程中产生的令牌类型
 */
export interface PlaceholderToken {
  /** 令牌类型：html_block表示HTML内容块，placeholder表示JavaScript表达式占位符 */
  type: "html_block" | "placeholder";
  /** 令牌的文本内容 */
  content: string;
  /** 令牌在原始输入中的结束位置 */
  pos: number;
}

/**
 * 解析包含占位符的HTML内容
 * 
 * 这是一个生成器函数，逐步解析输入的HTML字符串，识别其中的JavaScript表达式占位符。
 * 解析器使用状态机来正确处理HTML语法，确保只在合适的上下文中识别占位符。
 * 
 * 占位符语法：
 * - ${expression}：JavaScript表达式占位符
 * - \${expression}：转义的占位符，不会被解析
 * 
 * 工作原理：
 * 1. 维护HTML解析状态，跟踪当前是否在标签内部
 * 2. 在数据状态（普通文本）中扫描 $ 字符
 * 3. 遇到 ${ 时启动JavaScript解析器验证表达式
 * 4. 正确处理嵌套的大括号和复杂的JavaScript语法
 * 5. 生成HTML块和占位符令牌
 * 
 * @param input 要解析的HTML字符串
 * @param start 开始解析的位置（默认为0）
 * @param end 结束解析的位置（默认为字符串末尾）
 * @yields PlaceholderToken 解析出的令牌（HTML块或占位符）
 */
export function* parsePlaceholder(input: string, start = 0, end = input.length): Generator<PlaceholderToken> {
  let state: number | undefined = STATE_DATA;  // 当前解析状态
  let tagNameStart: number | undefined;        // 标签名开始位置（开始标签或结束标签）
  let tagName: string | undefined;             // 当前开始标签名（仅用于原始文本处理，注意嵌套！）
  let afterDollar = false;                     // 是否刚遇到 $ 字符
  let afterBackslash = false;                  // 是否刚遇到 \ 字符（用于转义处理）
  let content = "";                            // 累积的HTML内容
  let index = start;                           // 当前处理的起始索引

  // 主解析循环：逐字符扫描输入
  for (let i = start; i < end; ++i) {
    const code = input.charCodeAt(i);

    // 检测内联表达式（仅在数据状态下进行）
    // 这是占位符识别的核心逻辑
    if (state === STATE_DATA) {
      if (code === CODE_BACKSLASH) {
        // 遇到反斜杠：可能是转义序列的开始
        afterBackslash = true;
      } else if (code === CODE_DOLLAR) {
        if (afterBackslash) {
          // \$ 序列：移除反斜杠，保留美元符号
          content += input.slice(index, (index = i) - 1);
          afterBackslash = false;
        } else {
          // 单独的 $：可能是占位符的开始
          afterDollar = true;
        }
      } else if (afterBackslash) {
        // 反斜杠后跟非美元符号
        afterBackslash = false;
        if (afterDollar && code === CODE_LBRACE) {
          // \${ 序列：移除反斜杠，保留 ${
          content += input.slice(index, (index = i) - 1);
        }
      } else if (afterDollar) {
        // 美元符号后的字符处理
        afterDollar = false;
        if (code === CODE_LBRACE) {
          // ${ 序列：开始解析JavaScript表达式
          const parser = new (Parser as any)(acornOptions, input, i + 1); // 使用私有构造函数
          let braces = 1; // 跟踪大括号的嵌套层次
          try {
            // 使用Acorn解析器逐个令牌解析，直到找到匹配的右大括号
            do {
              parser.nextToken();
              if (parser.type === tokTypes.braceL || parser.type === tokTypes.dollarBraceL) {
                // 遇到左大括号或模板字符串的 ${：增加嵌套层次
                ++braces;
              } else if (parser.type === tokTypes.braceR && !--braces) {
                // 遇到右大括号且嵌套层次归零：表达式结束
                if ((content += input.slice(index, i - 1))) {
                  // 输出累积的HTML内容
                  yield {type: "html_block", content, pos: i - 1};
                  content = "";
                }
                // 输出JavaScript表达式占位符
                yield {type: "placeholder", content: input.slice(i + 1, (i = parser.pos - 1)), pos: parser.pos};
                index = parser.pos;
                break;
              }
            } while (parser.type !== tokTypes.eof);
          } catch (error) {
            // 忽略语法错误（如未终止的模板字符串、错误的Unicode转义等）
            if (!(error instanceof SyntaxError)) throw error;
          }
        }
      } else {
        // 重置标志位
        afterBackslash = false;
        afterDollar = false;
      }
    }

    // HTML状态机处理
    // 基于HTML5规范的简化版本，专注于正确识别标签边界
    switch (state) {
      case STATE_DATA: {
        // 数据状态：普通文本内容
        if (code === CODE_LT) {
          state = STATE_TAG_OPEN;
        }
        break;
      }
      case STATE_TAG_OPEN: {
        // 标签开始状态：< 后的第一个字符
        if (code === CODE_BANG) {
          state = STATE_MARKUP_DECLARATION_OPEN;  // <!
        } else if (code === CODE_SLASH) {
          state = STATE_END_TAG_OPEN;             // </
        } else if (isAsciiAlphaCode(code)) {
          // 字母：开始标签名
          (tagNameStart = i), (tagName = undefined);
          (state = STATE_TAG_NAME), --i;
        } else if (code === CODE_QUESTION) {
          state = STATE_BOGUS_COMMENT, --i;      // <?
        } else {
          // 其他字符：不是有效标签，回到数据状态
          (state = STATE_DATA), --i;
        }
        break;
      }
      case STATE_END_TAG_OPEN: {
        // 结束标签开始状态：</ 后的字符
        if (isAsciiAlphaCode(code)) {
          (state = STATE_TAG_NAME), --i;
        } else if (code === CODE_GT) {
          state = STATE_DATA;                     // </> 形式
        } else {
          (state = STATE_BOGUS_COMMENT), --i;    // 无效语法
        }
        break;
      }
      case STATE_TAG_NAME: {
        // 标签名状态：读取标签名字符
        if (isSpaceCode(code)) {
          state = STATE_BEFORE_ATTRIBUTE_NAME;
          tagName = lower(input, tagNameStart, i);
        } else if (code === CODE_SLASH) {
          state = STATE_SELF_CLOSING_START_TAG;   // <tag/
        } else if (code === CODE_GT) {
          // 标签结束：检查是否为原始文本元素
          tagName = lower(input, tagNameStart, i);
          state = isRawText(tagName) ? STATE_RAWTEXT : STATE_DATA;
        }
        break;
      }
      case STATE_BEFORE_ATTRIBUTE_NAME: {
        // 属性名前状态：标签名后的空白处理
        if (isSpaceCode(code)) {
          // 继续跳过空白
        } else if (code === CODE_SLASH || code === CODE_GT) {
          (state = STATE_AFTER_ATTRIBUTE_NAME), --i;
        } else if (code === CODE_EQ) {
          state = STATE_ATTRIBUTE_NAME;           // 异常的 = 号
        } else {
          (state = STATE_ATTRIBUTE_NAME), --i;   // 开始属性名
        }
        break;
      }
      case STATE_ATTRIBUTE_NAME: {
        // 属性名状态：读取属性名字符
        if (isSpaceCode(code) || code === CODE_SLASH || code === CODE_GT) {
          (state = STATE_AFTER_ATTRIBUTE_NAME), --i;
        } else if (code === CODE_EQ) {
          state = STATE_BEFORE_ATTRIBUTE_VALUE;  // 属性名后的 =
        }
        break;
      }
      case STATE_AFTER_ATTRIBUTE_NAME: {
        // 属性名后状态：可能有 = 号或直接结束
        if (isSpaceCode(code)) {
          // 继续跳过空白
        } else if (code === CODE_SLASH) {
          state = STATE_SELF_CLOSING_START_TAG;
        } else if (code === CODE_EQ) {
          state = STATE_BEFORE_ATTRIBUTE_VALUE;
        } else if (code === CODE_GT) {
          state = isRawText(tagName!) ? STATE_RAWTEXT : STATE_DATA;
        } else {
          (state = STATE_ATTRIBUTE_NAME), --i;   // 新的属性名
        }
        break;
      }
      case STATE_BEFORE_ATTRIBUTE_VALUE: {
        // 属性值前状态：= 号后的处理
        if (isSpaceCode(code)) {
          // 跳过空白
        } else if (code === CODE_DQUOTE) {
          state = STATE_ATTRIBUTE_VALUE_DOUBLE_QUOTED;  // "value"
        } else if (code === CODE_SQUOTE) {
          state = STATE_ATTRIBUTE_VALUE_SINGLE_QUOTED;  // 'value'
        } else if (code === CODE_GT) {
          state = isRawText(tagName!) ? STATE_RAWTEXT : STATE_DATA;
        } else {
          (state = STATE_ATTRIBUTE_VALUE_UNQUOTED), --i; // 无引号值
        }
        break;
      }
      case STATE_ATTRIBUTE_VALUE_DOUBLE_QUOTED: {
        // 双引号属性值状态
        if (code === CODE_DQUOTE) {
          state = STATE_AFTER_ATTRIBUTE_VALUE_QUOTED;
        }
        break;
      }
      case STATE_ATTRIBUTE_VALUE_SINGLE_QUOTED: {
        // 单引号属性值状态
        if (code === CODE_SQUOTE) {
          state = STATE_AFTER_ATTRIBUTE_VALUE_QUOTED;
        }
        break;
      }
      case STATE_ATTRIBUTE_VALUE_UNQUOTED: {
        // 无引号属性值状态
        if (isSpaceCode(code)) {
          state = STATE_BEFORE_ATTRIBUTE_NAME;
        } else if (code === CODE_GT) {
          state = isRawText(tagName!) ? STATE_RAWTEXT : STATE_DATA;
        }
        break;
      }
      case STATE_AFTER_ATTRIBUTE_VALUE_QUOTED: {
        // 引号属性值后状态
        if (isSpaceCode(code)) {
          state = STATE_BEFORE_ATTRIBUTE_NAME;
        } else if (code === CODE_SLASH) {
          state = STATE_SELF_CLOSING_START_TAG;
        } else if (code === CODE_GT) {
          state = isRawText(tagName!) ? STATE_RAWTEXT : STATE_DATA;
        } else {
          (state = STATE_BEFORE_ATTRIBUTE_NAME), --i;
        }
        break;
      }
      case STATE_SELF_CLOSING_START_TAG: {
        // 自闭合标签状态：/ 后必须是 >
        if (code === CODE_GT) {
          state = STATE_DATA;
        } else {
          (state = STATE_BEFORE_ATTRIBUTE_NAME), --i; // 回退处理
        }
        break;
      }
      case STATE_BOGUS_COMMENT: {
        // 伪注释状态：处理无效的注释语法
        if (code === CODE_GT) {
          state = STATE_DATA;
        }
        break;
      }
      case STATE_COMMENT_START: {
        // 注释开始状态：<!
        if (code === CODE_DASH) {
          state = STATE_COMMENT_START_DASH;
        } else if (code === CODE_GT) {
          state = STATE_DATA;
        } else {
          (state = STATE_COMMENT), --i;
        }
        break;
      }
      case STATE_COMMENT_START_DASH: {
        // 注释开始破折号状态：<!-
        if (code === CODE_DASH) {
          state = STATE_COMMENT_END;              // <!-- (空注释)
        } else if (code === CODE_GT) {
          state = STATE_DATA;                     // <!->
        } else {
          (state = STATE_COMMENT), --i;
        }
        break;
      }
      case STATE_COMMENT: {
        // 注释内容状态：正常的注释内容
        if (code === CODE_LT) {
          state = STATE_COMMENT_LESS_THAN_SIGN;  // 注释中的 <
        } else if (code === CODE_DASH) {
          state = STATE_COMMENT_END_DASH;         // 可能的注释结束
        }
        break;
      }
      case STATE_COMMENT_LESS_THAN_SIGN: {
        // 注释中小于号状态
        if (code === CODE_BANG) {
          state = STATE_COMMENT_LESS_THAN_SIGN_BANG;
        } else if (code !== CODE_LT) {
          (state = STATE_COMMENT), --i;
        }
        break;
      }
      case STATE_COMMENT_LESS_THAN_SIGN_BANG: {
        // 注释中 <! 状态
        if (code === CODE_DASH) {
          state = STATE_COMMENT_LESS_THAN_SIGN_BANG_DASH;
        } else {
          (state = STATE_COMMENT), --i;
        }
        break;
      }
      case STATE_COMMENT_LESS_THAN_SIGN_BANG_DASH: {
        // 注释中 <!- 状态
        if (code === CODE_DASH) {
          state = STATE_COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH;
        } else {
          (state = STATE_COMMENT_END), --i;
        }
        break;
      }
      case STATE_COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH: {
        // 注释中 <!-- 状态：嵌套注释开始
        (state = STATE_COMMENT_END), --i;
        break;
      }
      case STATE_COMMENT_END_DASH: {
        // 注释结束破折号状态：第一个 -
        if (code === CODE_DASH) {
          state = STATE_COMMENT_END;
        } else {
          (state = STATE_COMMENT), --i;
        }
        break;
      }
      case STATE_COMMENT_END: {
        // 注释结束状态：--
        if (code === CODE_GT) {
          state = STATE_DATA;                     // 注释正常结束 -->
        } else if (code === CODE_BANG) {
          state = STATE_COMMENT_END_BANG;         // --!
        } else if (code !== CODE_DASH) {
          (state = STATE_COMMENT), --i;          // 回到注释内容
        }
        break;
      }
      case STATE_COMMENT_END_BANG: {
        // 注释结束感叹号状态：--!
        if (code === CODE_DASH) {
          state = STATE_COMMENT_END_DASH;
        } else if (code === CODE_GT) {
          state = STATE_DATA;                     // --!> 结束
        } else {
          (state = STATE_COMMENT), --i;
        }
        break;
      }
      case STATE_MARKUP_DECLARATION_OPEN: {
        // 标记声明开始状态：<!
        if (code === CODE_DASH && input.charCodeAt(i + 1) === CODE_DASH) {
          // <!-- 注释开始
          (state = STATE_COMMENT_START), ++i;
        } else {
          // 注意：不支持CDATA和DOCTYPE！
          (state = STATE_BOGUS_COMMENT), --i;
        }
        break;
      }
      case STATE_RAWTEXT: {
        // 原始文本状态：script、style等元素的内容
        // 在这种状态下，只有对应的结束标签才能结束原始文本
        if (code === CODE_LT) {
          state = STATE_RAWTEXT_LESS_THAN_SIGN;
        }
        break;
      }
      case STATE_RAWTEXT_LESS_THAN_SIGN: {
        // 原始文本中的小于号状态
        if (code === CODE_SLASH) {
          state = STATE_RAWTEXT_END_TAG_OPEN;     // </
        } else {
          (state = STATE_RAWTEXT), --i;          // 不是结束标签
        }
        break;
      }
      case STATE_RAWTEXT_END_TAG_OPEN: {
        // 原始文本结束标签开始状态
        if (isAsciiAlphaCode(code)) {
          tagNameStart = i;
          (state = STATE_RAWTEXT_END_TAG_NAME), --i;
        } else {
          (state = STATE_RAWTEXT), --i;          // 不是有效的结束标签
        }
        break;
      }
      case STATE_RAWTEXT_END_TAG_NAME: {
        // 原始文本结束标签名状态
        // 只有当标签名匹配时才真正结束原始文本状态
        if (isSpaceCode(code) && tagName === lower(input, tagNameStart, i)) {
          state = STATE_BEFORE_ATTRIBUTE_NAME;
        } else if (code === CODE_SLASH && tagName === lower(input, tagNameStart, i)) {
          state = STATE_SELF_CLOSING_START_TAG;
        } else if (code === CODE_GT && tagName === lower(input, tagNameStart, i)) {
          state = STATE_DATA;
        } else if (!isAsciiAlphaCode(code)) {
          (state = STATE_RAWTEXT), --i;          // 标签名不匹配，继续原始文本
        }
        break;
      }
      default: {
        // 未知状态：结束解析
        state = undefined;
        break;
      }
    }
  }

  // 输出剩余的内容（如果有的话）
  if ((content += input.slice(index, end))) yield {type: "html_block", content, pos: end};
}

/**
 * 检查字符码是否为ASCII字母
 * @param code 字符码
 * @returns 是否为ASCII字母（A-Z或a-z）
 */
function isAsciiAlphaCode(code: number): boolean {
  return (CODE_UPPER_A <= code && code <= CODE_UPPER_Z) || (CODE_LOWER_A <= code && code <= CODE_LOWER_Z);
}

/**
 * 检查字符码是否为空白字符
 * 包括制表符、换行符、换页符、空格和回车符
 * @param code 字符码
 * @returns 是否为空白字符
 */
function isSpaceCode(code: number): boolean {
  return code === CODE_TAB || code === CODE_LF || code === CODE_FF || code === CODE_SPACE || code === CODE_CR; // normalize newlines
}

/**
 * 检查标签是否为原始文本元素
 * 原始文本元素的内容不会被进一步解析，直到遇到对应的结束标签
 * @param tagName 标签名（小写）
 * @returns 是否为原始文本元素
 */
function isRawText(tagName: string): boolean {
  return tagName === "script" || tagName === "style" || isEscapableRawText(tagName);
}

/**
 * 检查标签是否为可转义的原始文本元素
 * 这些元素可以包含字符引用，但不能包含其他标签
 * @param tagName 标签名（小写）
 * @returns 是否为可转义的原始文本元素
 */
function isEscapableRawText(tagName: string): boolean {
  return tagName === "textarea" || tagName === "title";
}

/**
 * 将输入字符串的指定部分转换为小写
 * @param input 输入字符串
 * @param start 开始位置（可选）
 * @param end 结束位置（可选）
 * @returns 转换为小写的字符串片段
 */
function lower(input: string, start?: number | undefined, end?: number | undefined): string {
  return input.slice(start, end).toLowerCase();
}
