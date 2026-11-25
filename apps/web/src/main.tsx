import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider, App as AntdApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App.tsx'
import './index.css'

/**
 * 全局品牌主题配置：
 * 承接 design/brand/README.md 的「深墨蓝 × 温润纸白 × 青铜金点睛」体系，
 * 替换默认 Ant Design 亮蓝与冷灰模板观感。
 */
const KH_THEME = {
  token: {
    colorPrimary: '#2352A0',
    colorInfo: '#2352A0',
    colorSuccess: '#2F855A',
    colorWarning: '#C27803',
    colorError: '#C53030',
    colorLink: '#2352A0',
    colorLinkHover: '#1B3F7D',
    colorTextBase: '#1F2937',
    colorTextHeading: '#1B2A41',
    colorTextSecondary: '#5A6577',
    colorTextTertiary: '#8A94A6',
    colorBgLayout: '#F8F7F3',
    colorBgContainer: '#FFFFFF',
    colorBorder: '#E6E3D8',
    colorBorderSecondary: '#EFECE3',
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 6,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  },
  components: {
    Button: {
      primaryShadow: 'none',
      defaultBorderColor: '#DCD8CB',
      defaultColor: '#1B2A41',
    },
    Card: {
      headerBg: 'transparent',
      headerFontSize: 15,
      colorBorderSecondary: '#EAE7DD',
    },
    Table: {
      headerBg: '#F6F5F1',
      headerColor: '#1B2A41',
      headerSplitColor: '#E6E3D8',
      borderColor: '#EFECE3',
      rowHoverBg: '#F7F8FA',
    },
    Input: {
      activeBorderColor: '#2352A0',
      hoverBorderColor: '#8CA4CC',
      activeShadow: '0 0 0 2px rgba(35, 82, 160, 0.08)',
    },
    Select: {
      optionSelectedBg: '#EEF3FA',
    },
    Segmented: {
      trackBg: '#F1EFE8',
      itemSelectedBg: '#FFFFFF',
      itemSelectedColor: '#1B2A41',
    },
    Tag: {
      borderRadiusSM: 6,
    },
  },
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider locale={zhCN} theme={KH_THEME}>
      <AntdApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  </StrictMode>,
)
