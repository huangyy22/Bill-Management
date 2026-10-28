# 拾账｜报销管理

本地桌面报销管理，凭证仅保存在本机。需要 Node.js 22.12 或更高版本。

## Windows 安装与运行

```bash
git clone https://github.com/huangyy22/Bill-Management.git
cd Bill-Management
npm install
npm start
```

打包：

```bash
npm run pack
```

运行 `dist\拾账-win32-x64\拾账.exe`。

## Linux 安装与运行

```bash
git clone https://github.com/huangyy22/Bill-Management.git
cd Bill-Management
npm install
npm start
```

打包：

```bash
npm run pack:linux
```

运行 `dist/拾账-linux-x64/拾账`。

常见问题：

```bash
# Ubuntu 缺少运行库
sudo apt install libgtk-3-0 libnss3 libasound2

# Electron sandbox 报错
npm start -- --no-sandbox

# 打包时证书校验失败
NODE_OPTIONS=--use-system-ca npm run pack:linux
```

## 首次启动

首次启动会弹出文件夹选择框；选择后自动记住。之后可在左下角点击“更换文件夹”修改。

Linux 使用内置离线中英文 OCR；Windows 使用系统 OCR。

## 数据与隐私

所有凭证只保存在你选择的文件夹，不上传网络。迁移或备份时请连同隐藏的 `.拾账` 文件夹一起保留。
