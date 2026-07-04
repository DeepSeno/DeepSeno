import { useRef, useEffect, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom, type ZoomBehavior } from 'd3-zoom';
import { drag, type D3DragEvent } from 'd3-drag';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useI18n } from '../../i18n';

// ─── Types ────────────────────────────────────────────────────

interface GraphNode extends SimulationNodeDatum {
  id: number;
  slug: string;
  type: string;
  title: string;
  summary: string | null;
  compilation_count: number;
}

interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  from_page_id: number;
  to_page_id: number;
  link_type: string;
  context: string | null;
}

interface PageGraphProps {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  selectedSlug?: string;
  onSelectPage: (slug: string) => void;
}

// ─── Colors (CSS variables, editorial palette) ────────────────
// person → info (blue), topic → accent (ochre/warn), project → success (green), concept → violet
const TYPE_FILL: Record<string, string> = {
  person:  'var(--c-info-bg)',
  topic:   'var(--c-accent-bg)',
  project: 'var(--c-success-bg)',
  concept: 'var(--c-violet-bg)',
};

const TYPE_STROKE: Record<string, string> = {
  person:  'var(--c-info)',
  topic:   'var(--c-accent)',
  project: 'var(--c-success)',
  concept: 'var(--c-violet)',
};

// ─── Component ────────────────────────────────────────────────

export default function PageGraph({ graph, selectedSlug, onSelectPage }: PageGraphProps) {
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  const typeLabel = (type: string): string => {
    const k = (t as any)?.knowledge || {};
    const map: Record<string, string> = {
      person: k.type_person || 'Person',
      topic: k.type_topic || 'Topic',
      project: k.type_project || 'Project',
      concept: k.type_concept || 'Concept',
    };
    return map[type] || type;
  };

  const renderGraph = useCallback(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return;
    if (!graph.nodes.length) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    // Clear previous render
    const svgSel = select(svg);
    svgSel.selectAll('*').remove();
    svgSel.attr('viewBox', `0 0 ${width} ${height}`);

    // Create container group for zoom/pan
    const g = svgSel.append('g');

    // Zoom behavior
    const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    svgSel.call(zoomBehavior);

    // Prepare data — clone nodes to avoid mutation
    const nodes: GraphNode[] = graph.nodes.map((n) => ({ ...n }));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const links = graph.edges
      .map((e) => ({
        source: nodeMap.get(e.from_page_id),
        target: nodeMap.get(e.to_page_id),
        link_type: e.link_type,
      }))
      .filter((l) => l.source && l.target) as Array<{
        source: GraphNode;
        target: GraphNode;
        link_type: string;
      }>;

    // Simulation
    const simulation = forceSimulation(nodes)
      .force(
        'link',
        forceLink(links)
          .id((d: any) => d.id)
          .distance(80),
      )
      .force('charge', forceManyBody().strength(-200))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide(30));

    // Draw links
    const link = g
      .append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', 'var(--line-strong)')
      .attr('stroke-width', 1)
      .attr('stroke-opacity', 0.7);

    // Draw nodes
    const node = g
      .append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, GraphNode>('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .on('click', (_event, d) => {
        onSelectPage(d.slug);
      });

    // Node circles
    node
      .append('circle')
      .attr('r', (d) => Math.min(6 + (d.compilation_count || 0) * 1.5, 18))
      .attr('fill', (d) => TYPE_FILL[d.type] || 'var(--bg-elev)')
      .attr('stroke', (d) => {
        if (d.slug === selectedSlug) return 'var(--ink)'; // strong ink for selected
        return TYPE_STROKE[d.type] || 'var(--line-strong)';
      })
      .attr('stroke-width', (d) => (d.slug === selectedSlug ? 2.5 : 1.5));

    // Node labels
    node
      .append('text')
      .text((d) => d.title)
      .attr('x', 0)
      .attr('y', (d) => Math.min(6 + (d.compilation_count || 0) * 1.5, 18) + 12)
      .attr('text-anchor', 'middle')
      .attr('font-size', '10px')
      .attr('font-family', 'var(--sans)')
      .attr('fill', 'var(--ink-soft)')
      .attr('pointer-events', 'none');

    // Drag behavior
    const dragBehavior = drag<SVGGElement, GraphNode>()
      .on('start', (event: D3DragEvent<SVGGElement, GraphNode, GraphNode>, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event: D3DragEvent<SVGGElement, GraphNode, GraphNode>, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event: D3DragEvent<SVGGElement, GraphNode, GraphNode>, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    node.call(dragBehavior);

    // Tick
    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);

      node.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });

    // No auto-fit: let the user control zoom/pan manually.
    // With many nodes, auto-fit shrinks everything to illegible size.

    return () => {
      simulation.stop();
    };
  }, [graph, selectedSlug, onSelectPage]);

  useEffect(() => {
    renderGraph();
  }, [renderGraph, expanded]);

  // Re-render on resize
  useEffect(() => {
    const observer = new ResizeObserver(() => renderGraph());
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [renderGraph]);

  if (!graph.nodes.length) {
    return (
      <div className="flex items-center justify-center h-full kz-mono kz-text-mute" style={{ fontSize: 11 }}>
        No data for graph
      </div>
    );
  }

  // Fullscreen overlay rendered via portal
  if (expanded) {
    return (
      <>
        {/* Keep an empty placeholder so layout doesn't collapse */}
        <div className="h-full" />
        {createPortal(
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 99999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* Backdrop */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(0,0,0,0.4)',
                backdropFilter: 'blur(4px)',
              }}
              onClick={() => setExpanded(false)}
            />
            {/* Graph container */}
            <div
              ref={containerRef}
              className="kz-paper"
              style={{
                position: 'relative',
                width: 'calc(100vw - 32px)',
                height: 'calc(100vh - 32px)',
                overflow: 'hidden',
                zIndex: 1,
              }}
            >
              <button
                onClick={() => setExpanded(false)}
                className="kz-btn kz-btn--sm"
                style={{ position: 'absolute', top: 12, right: 12, zIndex: 10 }}
                title="Collapse"
              >
                <Minimize2 size={14} />
              </button>
              <div
                className="kz-card"
                style={{
                  position: 'absolute', bottom: 12, left: 12, zIndex: 10,
                  display: 'flex', gap: 10, padding: '6px 10px',
                  fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-mute)',
                }}
              >
                {(['person', 'topic', 'project', 'concept'] as const).map((type) => (
                  <div key={type} className="flex items-center gap-1">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full"
                      style={{ background: TYPE_FILL[type], border: `1px solid ${TYPE_STROKE[type]}` }}
                    />
                    {typeLabel(type)}
                  </div>
                ))}
              </div>
              <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
            </div>
          </div>,
          document.body,
        )}
      </>
    );
  }

  // Inline (non-expanded) mode
  return (
    <div
      ref={containerRef}
      className="kz-paper relative h-full overflow-hidden"
    >
      <button
        onClick={() => setExpanded(true)}
        className="kz-btn kz-btn--sm"
        style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
        title="Expand"
      >
        <Maximize2 size={13} />
      </button>
      <div
        className="kz-card"
        style={{
          position: 'absolute', bottom: 8, left: 8, zIndex: 10,
          display: 'flex', gap: 8, padding: '4px 8px',
          fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-mute)',
        }}
      >
        {(['person', 'topic', 'project', 'concept'] as const).map((type) => (
          <div key={type} className="flex items-center gap-1">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: TYPE_FILL[type], border: `1px solid ${TYPE_STROKE[type]}` }}
            />
            {typeLabel(type)}
          </div>
        ))}
      </div>
      <svg ref={svgRef} className="w-full h-full" />
    </div>
  );
}
