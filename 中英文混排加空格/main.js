// 盘古之白 - 中英文间距插件
// 在中文与英文/数字边界处，通过 letterSpacing 添加字号 1/4 的间距
// 不修改文字内容，只调整字符间距

mg.showUI(__html__, { width: 320, height: 480 });

mg.ui.onmessage = function(msg) {
  if (msg.type === 'run') {
    processNodes(msg.scope).then(function(result) {
      mg.ui.postMessage({ type: 'done', count: result.count, total: result.total, message: result.message });
    }).catch(function(e) {
      mg.ui.postMessage({ type: 'done', count: 0, total: 0, message: '发生错误：' + String(e) });
    });
  } else if (msg.type === 'cancel') {
    mg.closePlugin();
  }
};

// ─── CJK 字符判断 ────────────────────────────────────────────────

var CJK_RANGES = [
  [0x2e80, 0x2eff], [0x2f00, 0x2fdf], [0x3040, 0x309f], [0x30a0, 0x30ff],
  [0x3100, 0x312f], [0x3200, 0x32ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa960, 0xa97f], [0xac00, 0xd7ff], [0xf900, 0xfaff], [0xfe10, 0xfe1f],
  [0xfe30, 0xfe4f], [0xff00, 0xffef]
];

function isCJK(ch) {
  var code = ch.charCodeAt(0);
  for (var i = 0; i < CJK_RANGES.length; i++) {
    if (code >= CJK_RANGES[i][0] && code <= CJK_RANGES[i][1]) return true;
  }
  return false;
}

function isLatinOrDigit(ch) {
  var code = ch.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) ||  // A-Z
         (code >= 0x61 && code <= 0x7a) ||  // a-z
         (code >= 0x30 && code <= 0x39);    // 0-9
}

// 货币符号：这些符号紧跟数字时不加间距
var CURRENCY_SYMBOLS = { '￥': true, '¥': true, '$': true, '€': true, '£': true, '₩': true, '₪': true, '₫': true, '₹': true, '฿': true };

// 判断两个相邻字符之间是否需要加间距
// 返回 true（给左侧字符加右间距）或 false（不加）
function needsSpacing(leftCh, rightCh) {
  // 排除：货币符号 + 数字（如 ￥100、$99）
  if (CURRENCY_SYMBOLS[leftCh] && isLatinOrDigit(rightCh)) return false;
  // 排除：数字 + 货币符号（如 100￥，虽少见也排除）
  if (isLatinOrDigit(leftCh) && CURRENCY_SYMBOLS[rightCh]) return false;

  if (isCJK(leftCh) && isLatinOrDigit(rightCh)) return true;
  if (isLatinOrDigit(leftCh) && isCJK(rightCh)) return true;
  return false;
}

// ─── 递归收集文本节点 ────────────────────────────────────────────

function collectTextNodes(node, nodes) {
  if (!nodes) nodes = [];
  if (node.type === 'TEXT') {
    nodes.push(node);
  }
  if (node.children) {
    for (var i = 0; i < node.children.length; i++) {
      collectTextNodes(node.children[i], nodes);
    }
  }
  return nodes;
}

// ─── 加载节点所有字体 ────────────────────────────────────────────

function loadAllFonts(node) {
  var fontsSet = {};
  var styles = node.textStyles;
  if (styles && styles.length > 0) {
    for (var i = 0; i < styles.length; i++) {
      var fn = styles[i].textStyle.fontName;
      if (fn && fn !== mg.mixed) {
        fontsSet[fn.family + '::' + fn.style] = fn;
      }
    }
  }
  // 兜底：用节点默认字体
  var keys = Object.keys(fontsSet);
  if (keys.length === 0) {
    try {
      var dfn = node.fontName;
      if (dfn && dfn !== mg.mixed) {
        fontsSet[dfn.family + '::' + dfn.style] = dfn;
        keys = Object.keys(fontsSet);
      }
    } catch(e) {}
  }
  var promises = [];
  for (var k = 0; k < keys.length; k++) {
    promises.push(mg.loadFontAsync(fontsSet[keys[k]]));
  }
  if (promises.length === 0) {
    promises.push(mg.loadFontAsync({ family: 'PingFang SC', style: 'Regular' }));
  }
  return Promise.all(promises);
}

// ─── 处理单个文本节点 ────────────────────────────────────────────

function processTextNode(node) {
  // 使用 Array.from 正确处理多字节字符（emoji 等）
  var chars = Array.from(node.characters);
  var len = chars.length;

  if (len < 2) return Promise.resolve(false);

  // 找出所有需要加间距的边界位置
  // boundaries[i] = spacing(px)，表示第 i 个字符需要在其右侧追加的间距
  var boundaries = {};
  for (var i = 0; i < len - 1; i++) {
    if (needsSpacing(chars[i], chars[i + 1]) === true) {
      boundaries[i] = true;
    }
  }

  if (Object.keys(boundaries).length === 0) {
    return Promise.resolve(false);
  }

  return loadAllFonts(node).then(function() {
    // 读取每个字符当前的 letterSpacing 和 fontSize
    // textStyles 是按范围分段的，需要按字符位置查找
    var styles = node.textStyles;

    // 构建字符位置 → 样式段 的映射（懒查找）
    function getStyleAt(charIndex) {
      for (var s = 0; s < styles.length; s++) {
        if (charIndex >= styles[s].start && charIndex < styles[s].end) {
          return styles[s].textStyle;
        }
      }
      return null;
    }

    // 计算字符的实际 UTF-16 偏移（因为 Array.from 按码点，API 按 UTF-16 索引）
    // 对于 BMP 字符（绝大多数中英文），码点索引 = UTF-16 索引
    // 这里简化处理：直接用码点索引（对中英文场景完全正确）
    var modified = false;

    // 按边界位置设置 letterSpacing
    // 策略：给边界左侧字符的 letterSpacing 增加 fontSize/4（PIXELS）
    // 需要保留原有 letterSpacing，在其基础上叠加
    var boundaryKeys = Object.keys(boundaries);
    for (var b = 0; b < boundaryKeys.length; b++) {
      var idx = parseInt(boundaryKeys[b], 10);
      var style = getStyleAt(idx);
      if (!style) continue;

      var fontSize = style.fontSize || 16;
      var addPx = fontSize / 6;

      // 读取原有 letterSpacing
      var origLS = style.letterSpacing;
      var origPx = 0;
      if (origLS) {
        if (origLS.unit === 'PIXELS') {
          origPx = origLS.value;
        } else if (origLS.unit === 'PERCENT') {
          // 百分比转像素：value% * fontSize / 100
          origPx = (origLS.value / 100) * fontSize;
        }
      }

      var newPx = origPx + addPx;

      // setRangeLetterSpacing 的范围是 [start, end)，单个字符就是 [idx, idx+1)
      node.setRangeLetterSpacing(idx, idx + 1, { value: newPx, unit: 'PIXELS' });
      modified = true;
    }

    return modified;
  }).catch(function(e) {
    console.error('处理文本节点失败:', node.name, String(e));
    return false;
  });
}

// ─── 串行处理节点列表 ────────────────────────────────────────────

function processTextNodesSerial(nodes, index, modifiedCount, total) {
  if (index >= nodes.length) {
    return Promise.resolve(modifiedCount);
  }
  mg.ui.postMessage({ type: 'progress', current: index + 1, total: total });
  return processTextNode(nodes[index]).then(function(modified) {
    return processTextNodesSerial(nodes, index + 1, modifiedCount + (modified ? 1 : 0), total);
  });
}

// ─── 根据范围收集并处理 ──────────────────────────────────────────

function processNodes(scope) {
  var textNodes = [];

  var currentPage = mg.document.currentPage || (mg.document.children && mg.document.children[0]);
  if (!currentPage) {
    return Promise.resolve({ count: 0, total: 0, message: '无法获取当前页面，请重试' });
  }

  if (scope === 'selection') {
    var selection = currentPage.selection;
    if (!selection || selection.length === 0) {
      return Promise.resolve({ count: 0, total: 0, message: '请先选择要处理的图层' });
    }
    for (var i = 0; i < selection.length; i++) {
      collectTextNodes(selection[i], textNodes);
    }
  } else if (scope === 'page') {
    collectTextNodes(currentPage, textNodes);
  } else {
    var pages = mg.document.children;
    for (var p = 0; p < pages.length; p++) {
      collectTextNodes(pages[p], textNodes);
    }
  }

  if (textNodes.length === 0) {
    return Promise.resolve({ count: 0, total: 0, message: '未找到任何文本图层' });
  }

  var total = textNodes.length;
  return processTextNodesSerial(textNodes, 0, 0, total).then(function(modifiedCount) {
    return {
      count: modifiedCount,
      total: total,
      message: '处理完成！共扫描 ' + total + ' 个文本图层，修改了 ' + modifiedCount + ' 个。'
    };
  });
}
