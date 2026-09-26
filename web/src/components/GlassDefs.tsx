'use client';
/**
 * 苹果「液态玻璃」（Liquid Glass）滤镜定义。
 *
 * 浏览器里做"折射凹凸"的关键：磨砂只是模糊，真正的体积感来自**边缘把背后画面弯折**——
 * 用 feDisplacementMap 对 backdrop 做位移，位移量由一张法线图给出：
 * R 通道 = 水平位移方向、G 通道 = 垂直位移方向，中灰(0x80) 表示不位移。
 * 于是"内芯纯中灰、四边带梯度"的图 = 中间平坦、四边像透镜一样折光的凹凸边。
 *
 * 两个踩过的坑：
 * ① 渐变填充会同时改 R 和 G，所以水平/垂直两张图必须分开生成，再用 feColorMatrix 各取一个通道、
 *    feComposite 相加——否则底边会连带做水平位移，画面变成随机条纹错位。
 * ② 法线图用 data URI 内联：feImage 拉外链在 backdrop-filter 里有时序与跨域风险。
 * 图会被 preserveAspectRatio="none" 拉伸到元素尺寸，所以边带按比例设计：
 * 垂直边带占高 27%（顶栏 52px → 14px 折光带），水平边带占宽约 3%（1440px → 46px）。
 */

/** 单通道法线图：内芯 #808080（不平移），指定边带按方向渐变，整组高斯模糊后平滑过渡到平坦区 */
function edgeMap(bands: string, blur: number): string {
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240'>
        <defs>
          <linearGradient id='up' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff'/><stop offset='1' stop-color='#808080'/></linearGradient>
          <linearGradient id='down' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#808080'/><stop offset='1' stop-color='#000'/></linearGradient>
          <linearGradient id='left' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='#000'/><stop offset='1' stop-color='#808080'/></linearGradient>
          <linearGradient id='right' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='#808080'/><stop offset='1' stop-color='#fff'/></linearGradient>
          <filter id='s' x='-40%' y='-40%' width='180%' height='180%'><feGaussianBlur stdDeviation='${blur}'/></filter>
        </defs>
        <rect width='240' height='240' fill='#808080'/>
        <g filter='url(#s)'>${bands}</g>
      </svg>`,
    )
  );
}

/** 垂直位移图（G 通道）：上边把背后内容往里吸、下边同样往里吸 → 上下缘像镜片一样收拢 */
const MAP_V = edgeMap(
  `<rect x='0' y='0' width='240' height='64' fill='url(#up)'/>
   <rect x='0' y='168' width='240' height='72' fill='url(#down)'/>`,
  16,
);
/** 水平位移图（R 通道）：左边往左吸、右边往右吸 */
const MAP_H = edgeMap(
  `<rect x='0' y='0' width='8' height='240' fill='url(#left)'/>
   <rect x='232' y='0' width='8' height='240' fill='url(#right)'/>`,
  3,
);

export default function GlassDefs() {
  return (
    <svg className="glass-defs" aria-hidden focusable="false">
      <defs>
        <filter id="liquid-glass" x="-8%" y="-25%" width="116%" height="150%" colorInterpolationFilters="sRGB">
          <feImage href={MAP_H} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="hm" />
          <feImage href={MAP_V} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="vm" />
          {/* 各取一个通道再相加 → 合成法线图（R=水平、G=垂直） */}
          <feColorMatrix in="hm" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="hr" />
          <feColorMatrix in="vm" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="vg" />
          <feComposite in="hr" in2="vg" operator="arithmetic" k2="1" k3="1" result="bump" />
          {/* 磨砂 → 按法线折光 → 提饱和（让透过玻璃的颜色更"活"） */}
          <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="frost" />
          <feDisplacementMap in="frost" in2="bump" scale="26" xChannelSelector="R" yChannelSelector="G" result="refract" />
          <feColorMatrix
            in="refract"
            type="matrix"
            values="1.14 -0.05 -0.05 0 0  -0.05 1.14 -0.05 0 0  -0.05 -0.05 1.14 0 0  0 0 0 1 0"
          />
        </filter>
        {/* 流体选择器用的 gooey 滤镜（CSS-Tricks / Codrops 的经典配方）：
            先模糊，再用 feColorMatrix 把 alpha 通道拉成阶跃（×22 再减 10）——
            两团重叠处糊成一片、拉开时掐成细颈再断成水滴，颜色通道保持原样。
            滤镜区域放大到 130%/180%，否则拉丝到边缘的形状会被裁掉。 */}
        <filter id="goo" x="-15%" y="-45%" width="130%" height="190%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b" />
          <feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10" />
        </filter>
      </defs>
    </svg>
  );
}
