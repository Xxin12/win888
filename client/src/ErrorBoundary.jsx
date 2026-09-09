import React from 'react';

/**
 * 顶层错误边界: 任何页面/图表渲染或 effect 中抛出的异常都会被捕获,
 * 显示可读的错误卡片 + 重试按钮, 而不是整页空白。
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // 同时打到控制台, 便于排查
    console.error('[quant-web] 渲染异常被边界捕获:', error, info);
  }
  handleRetry = () => this.setState({ error: null });
  render() {
    if (this.state.error) {
      const msg = (this.state.error && this.state.error.message) || String(this.state.error);
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
          <div style={{ background: '#fff3f3', border: '1px solid #ffccc7', borderRadius: 8, padding: 16 }}>
            <h2 style={{ margin: '0 0 8px', color: '#cf1322' }}>⚠️ 页面渲染出错</h2>
            <p style={{ margin: '0 0 8px', color: '#333', wordBreak: 'break-word' }}>{msg}</p>
            <pre style={{ background: '#fff', border: '1px solid #eee', padding: 10, fontSize: 12, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {this.state.error && this.state.error.stack ? this.state.error.stack : ''}
            </pre>
            <button className="btn primary" style={{ marginTop: 8 }} onClick={this.handleRetry}>重试</button>
            <button className="btn" style={{ marginTop: 8, marginLeft: 8 }} onClick={() => location.reload()}>刷新页面</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
