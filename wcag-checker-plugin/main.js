// WCAG 无障碍检测插件
// 基于 WCAG 2.1 标准，检测设计稿中的无障碍问题

mg.showUI(__html__, { width: 400, height: 600 });

mg.ui.onmessage = function(msg) {
  if (msg.type === 'run') {
    var scope = msg.scope;
    var issues = runChecks(scope);
    mg.ui.postMessage({ type: 'result', issues: issues });
  } else if (msg.type === 'select') {
    // 定位到问题节点
    var node = mg.getNodeById(msg.nodeId);
    if (node) {
      var currentPage = mg.document.currentPage || mg.document.children[0];
      currentPage.selection = [node];
      mg.viewport.scrollAndZoomIntoView([node]);
    }
  } else if (msg.type === 'cancel') {
    mg.closePlugin();
  }
};

// ═══════════════════════════════════════════════════════════════
// WCAG 色彩对比度算法（WCAG 2.1 §1.4.3 / §1.4.6）
// ═══════════════════════════════════════════════════════════════

// sRGB 线性化
function linearize(val) {
  var v = val / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// 计算相对亮度 (0~1)
function relativeLuminance(r, g, b) {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

// 计算对比度比值
function contrastRatio(l1, l2) {
  var lighter = Math.max(l1, l2);
  var darker  = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// 混合 alpha（前景色叠加到背景色）
function blendAlpha(fg, bg, alpha) {
  return {
    r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
    g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
    b: Math.round(fg.b * alpha + bg.b * (1 - alpha))
  };
}

// 从 Paint 数组中提取第一个纯色（SOLID），返回 {r,g,b,a} 或 null
function extractSolidColor(fills) {
  if (!fills || fills.length === 0) return null;
  for (var i = fills.length - 1; i >= 0; i--) {
    var fill = fills[i];
    if (fill.type === 'SOLID' && fill.visible !== false) {
      var c = fill.color;
      var opacity = (fill.opacity !== undefined ? fill.opacity : 1);
      return {
        r: Math.round(c.r * 255),
        g: Math.round(c.g * 255),
        b: Math.round(c.b * 255),
        a: opacity
      };
    }
  }
  return null;
}

// 向上遍历父节点，找到第一个有背景色的祖先
function findBackgroundColor(node) {
  var current = node.parent;
  var defaultBg = { r: 255, g: 255, b: 255 }; // 默认白色背景

  while (current) {
    if (current.type === 'PAGE') {
      // 页面背景色
      var pageFill = extractSolidColor(current.fills);
      if (pageFill) {
        return blendAlpha(pageFill, defaultBg, pageFill.a);
      }
      return defaultBg;
    }
    if (current.fills) {
      var fill = extractSolidColor(current.fills);
      if (fill) {
        // 考虑节点自身 opacity
        var nodeOpacity = (current.opacity !== undefined ? current.opacity : 1);
        var effectiveAlpha = fill.a * nodeOpacity;
        return blendAlpha(fill, defaultBg, effectiveAlpha);
      }
    }
    current = current.parent;
  }
  return defaultBg;
}

// ═══════════════════════════════════════════════════════════════
// 节点遍历
// ═══════════════════════════════════════════════════════════════

function collectNodes(root, results) {
  if (!results) results = [];
  if (!root) return results;

  // 跳过不可见节点
  if (root.isVisible === false) return results;

  results.push(root);
  if (root.children) {
    for (var i = 0; i < root.children.length; i++) {
      collectNodes(root.children[i], results);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// 检测规则
// ═══════════════════════════════════════════════════════════════

// 规则1：文字对比度（WCAG 1.4.3 AA / 1.4.6 AAA）
function checkTextContrast(node) {
  if (node.type !== 'TEXT') return null;
  if (!node.characters || node.characters.trim() === '') return null;

  // 获取文字颜色
  var textFill = null;
  // 优先从 textStyles 分段取第一段颜色
  if (node.textStyles && node.textStyles.length > 0) {
    textFill = extractSolidColor(node.textStyles[0].fills);
  }
  if (!textFill) {
    textFill = extractSolidColor(node.fills);
  }
  if (!textFill) return null;

  // 获取背景色
  var bg = findBackgroundColor(node);

  // 混合文字透明度到背景
  var nodeOpacity = (node.opacity !== undefined ? node.opacity : 1);
  var effectiveAlpha = textFill.a * nodeOpacity;
  var blended = blendAlpha(textFill, bg, effectiveAlpha);

  var fgL = relativeLuminance(blended.r, blended.g, blended.b);
  var bgL = relativeLuminance(bg.r, bg.g, bg.b);
  var ratio = contrastRatio(fgL, bgL);

  // 判断文字大小（大文字：粗体≥14px 或 普通≥18px）
  var fontSize = 16;
  var isBold = false;
  if (node.textStyles && node.textStyles.length > 0) {
    fontSize = node.textStyles[0].textStyle.fontSize || 16;
    var fw = node.textStyles[0].textStyle.fontWeight || 400;
    isBold = fw >= 700;
  } else {
    try {
      fontSize = node.fontSize !== mg.mixed ? (node.fontSize || 16) : 16;
    } catch(e) {}
  }

  var isLargeText = (isBold && fontSize >= 14) || (!isBold && fontSize >= 18);

  // WCAG 标准
  var aaThreshold  = isLargeText ? 3.0 : 4.5;
  var aaaThreshold = isLargeText ? 4.5 : 7.0;

  var ratioFixed = Math.round(ratio * 100) / 100;

  if (ratio >= aaaThreshold) return null; // AAA 通过，无问题

  var level, desc, suggestion;
  if (ratio >= aaThreshold) {
    // AA 通过，AAA 不通过
    level = 'warning';
    desc = '对比度 ' + ratioFixed + ':1，通过 AA 但未达到 AAA（需 ' + aaaThreshold + ':1）';
    suggestion = '建议提升对比度至 ' + aaaThreshold + ':1 以上，以满足 WCAG AAA 标准';
  } else {
    // AA 不通过
    level = 'error';
    desc = '对比度 ' + ratioFixed + ':1，未通过 AA 标准（需 ' + aaThreshold + ':1）';
    suggestion = '请调整文字颜色或背景色，使对比度达到 ' + aaThreshold + ':1 以上';
  }

  return {
    nodeId: node.id,
    nodeName: node.name || '文本图层',
    nodeType: 'TEXT',
    rule: 'contrast',
    ruleLabel: '色彩对比度',
    level: level,
    desc: desc,
    suggestion: suggestion,
    detail: {
      ratio: ratioFixed,
      fontSize: fontSize,
      isLargeText: isLargeText,
      fg: rgbToHex(blended.r, blended.g, blended.b),
      bg: rgbToHex(bg.r, bg.g, bg.b)
    }
  };
}

// 规则2：文字大小（WCAG 1.4.4）
function checkFontSize(node) {
  if (node.type !== 'TEXT') return null;
  if (!node.characters || node.characters.trim() === '') return null;

  var fontSize = 16;
  try {
    if (node.textStyles && node.textStyles.length > 0) {
      fontSize = node.textStyles[0].textStyle.fontSize || 16;
    } else {
      fontSize = node.fontSize !== mg.mixed ? (node.fontSize || 16) : 16;
    }
  } catch(e) {}

  if (fontSize < 10) {
    return {
      nodeId: node.id,
      nodeName: node.name || '文本图层',
      nodeType: 'TEXT',
      rule: 'font-size',
      ruleLabel: '文字大小',
      level: 'error',
      desc: '文字大小 ' + fontSize + 'px，过小导致难以阅读',
      suggestion: '正文建议不小于 16px，辅助文字不小于 12px',
      detail: { fontSize: fontSize }
    };
  }
  if (fontSize < 12) {
    return {
      nodeId: node.id,
      nodeName: node.name || '文本图层',
      nodeType: 'TEXT',
      rule: 'font-size',
      ruleLabel: '文字大小',
      level: 'warning',
      desc: '文字大小 ' + fontSize + 'px，偏小',
      suggestion: '辅助文字建议不小于 12px，正文建议不小于 16px',
      detail: { fontSize: fontSize }
    };
  }
  return null;
}

// 规则3：可点击区域最小尺寸（WCAG 2.5.5）
// 检测名称含有交互语义关键词的图层
var INTERACTIVE_KEYWORDS = ['button', 'btn', 'icon', 'link', 'tab', 'checkbox', 'radio',
  'toggle', 'switch', 'chip', 'tag', 'close', 'delete', 'edit', 'menu', 'nav',
  '按钮', '图标', '链接', '标签', '关闭', '删除', '编辑', '菜单', '选项'];

function isInteractiveNode(node) {
  if (!node.name) return false;
  var name = node.name.toLowerCase();
  for (var i = 0; i < INTERACTIVE_KEYWORDS.length; i++) {
    if (name.indexOf(INTERACTIVE_KEYWORDS[i]) !== -1) return true;
  }
  return false;
}

function checkTouchTarget(node) {
  if (node.type === 'TEXT' || node.type === 'PAGE' || node.type === 'DOCUMENT') return null;
  if (!isInteractiveNode(node)) return null;

  var w = node.width  || 0;
  var h = node.height || 0;
  var MIN = 44;

  if (w < MIN || h < MIN) {
    return {
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      rule: 'touch-target',
      ruleLabel: '可点击区域',
      level: w < 24 || h < 24 ? 'error' : 'warning',
      desc: '尺寸 ' + Math.round(w) + '×' + Math.round(h) + 'px，小于推荐的 44×44px',
      suggestion: '交互元素的可点击区域建议不小于 44×44px（WCAG 2.5.5）',
      detail: { width: Math.round(w), height: Math.round(h) }
    };
  }
  return null;
}

// 规则4：图层命名（辅助开发交接）
var DEFAULT_NAME_PATTERNS = [
  /^(frame|group|rectangle|ellipse|line|polygon|star|vector|text|component|instance)\s*\d*$/i,
  /^图层\s*\d*$/,
  /^矩形\s*\d*$/,
  /^椭圆\s*\d*$/,
  /^文本\s*\d*$/,
  /^组\s*\d*$/,
  /^容器\s*\d*$/
];

function checkLayerNaming(node) {
  if (!node.name) return null;
  // 只检测 Frame 和 Component
  if (node.type !== 'FRAME' && node.type !== 'COMPONENT' && node.type !== 'INSTANCE') return null;

  var name = node.name.trim();
  for (var i = 0; i < DEFAULT_NAME_PATTERNS.length; i++) {
    if (DEFAULT_NAME_PATTERNS[i].test(name)) {
      return {
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        rule: 'naming',
        ruleLabel: '图层命名',
        level: 'info',
        desc: '"' + name + '" 使用了默认命名，不利于开发交接和无障碍标注',
        suggestion: '建议使用语义化名称，如 "登录按钮"、"用户头像" 等',
        detail: {}
      };
    }
  }
  return null;
}

// 规则5：图片缺少描述（WCAG 1.1.1）
function checkImageAlt(node) {
  if (!node.fills) return null;
  // 检测有图片填充的节点
  var hasImage = false;
  for (var i = 0; i < node.fills.length; i++) {
    if (node.fills[i].type === 'IMAGE' && node.fills[i].visible !== false) {
      hasImage = true;
      break;
    }
  }
  if (!hasImage) return null;

  // 检查节点名称是否包含描述性信息
  var name = (node.name || '').trim().toLowerCase();
  var hasDesc = name.length > 2 &&
    !(/^(rectangle|frame|image|img|photo|pic|图片|图像|矩形)\s*\d*$/i.test(name));

  if (!hasDesc) {
    return {
      nodeId: node.id,
      nodeName: node.name || '图片图层',
      nodeType: node.type,
      rule: 'image-alt',
      ruleLabel: '图片描述',
      level: 'warning',
      desc: '图片图层缺少语义化命名，开发时可能无法生成合适的 alt 文本',
      suggestion: '建议将图层命名为图片内容的描述，如 "用户头像"、"产品展示图"',
      detail: {}
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function rgbToHex(r, g, b) {
  return '#' +
    ('0' + r.toString(16)).slice(-2) +
    ('0' + g.toString(16)).slice(-2) +
    ('0' + b.toString(16)).slice(-2);
}

// ═══════════════════════════════════════════════════════════════
// 主检测入口
// ═══════════════════════════════════════════════════════════════

function runChecks(scope) {
  var currentPage = mg.document.currentPage || mg.document.children[0];
  if (!currentPage) return [];

  var rootNodes = [];
  if (scope === 'selection') {
    rootNodes = currentPage.selection || [];
  } else if (scope === 'page') {
    rootNodes = [currentPage];
  } else {
    rootNodes = mg.document.children || [];
  }

  // 收集所有节点
  var allNodes = [];
  for (var i = 0; i < rootNodes.length; i++) {
    collectNodes(rootNodes[i], allNodes);
  }

  var issues = [];
  for (var j = 0; j < allNodes.length; j++) {
    var node = allNodes[j];
    var result;

    result = checkTextContrast(node);
    if (result) issues.push(result);

    result = checkFontSize(node);
    if (result) issues.push(result);

    result = checkTouchTarget(node);
    if (result) issues.push(result);

    result = checkLayerNaming(node);
    if (result) issues.push(result);

    result = checkImageAlt(node);
    if (result) issues.push(result);
  }

  return issues;
}
