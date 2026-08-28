import { useUIStore } from '@tmex/stores/react';
import { THEME_PRESET_META } from '@tmex/theme';
import { useEffect, useId, useRef, useState } from 'react';

// 动态 import('mermaid') 渲染单个 mermaid 图。SVG 经 securityLevel:'strict' 净化后，
// 通过 ref + innerHTML 写入常驻容器（避免 dangerouslySetInnerHTML，规避 lint 与挂载竞态）。
export function MermaidBlock({ code }: { code: string }) {
  const reactId = useId();
  const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9-]/g, '')}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>('');
  // 从 store 读外观而不是探测 <html>.dark：切换主题/预设时组件才会重渲染并重绘 SVG。
  // 预设自带亮/暗，生效时以预设为准。
  const theme = useUIStore((state) => state.theme);
  const themePreset = useUIStore((state) => state.themePreset);
  const appearance = themePreset ? THEME_PRESET_META[themePreset].appearance : theme;

  useEffect(() => {
    let cancelled = false;

    async function render(): Promise<void> {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: appearance === 'dark' ? 'dark' : 'default',
          securityLevel: 'strict',
        });
        const { svg } = await mermaid.render(renderId, code);
        if (cancelled) return;
        setError('');
        if (containerRef.current) containerRef.current.innerHTML = svg;
      } catch (err) {
        if (cancelled) return;
        if (containerRef.current) containerRef.current.innerHTML = '';
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void render();

    return () => {
      cancelled = true;
    };
  }, [code, renderId, appearance]);

  return (
    <div className="my-2">
      {error && (
        <>
          <p className="text-destructive text-xs">Mermaid 渲染失败：{error}</p>
          <pre className="bg-muted mt-1 overflow-x-auto rounded-md p-2 font-mono text-xs leading-relaxed">
            {code}
          </pre>
        </>
      )}
      <div ref={containerRef} className="flex justify-center overflow-x-auto" />
    </div>
  );
}
