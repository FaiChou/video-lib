# Debian 部署：systemd 开机自动启动

使用服务器上已有的 Node.js 20+，不需要安装 npm 依赖或执行 build。以下操作在 Debian 服务器上执行，需要 `sudo` 权限；如果使用 root 登录，可省略 `sudo`。

默认项目位置为 `/opt/video-library`，视频存放在 `/opt/video-library/videos/用户名/`，访问端口为 `8876`。

当前版本没有登录鉴权：能访问页面的人都能浏览、下载和上传。请按实际使用范围配置服务器防火墙或云安全组的访问来源。

## 1. 上传项目并检查 Node

把解压后的整个 `video-library` 文件夹上传到服务器。例如在本地执行，将 `YOUR_USER` 和 `YOUR_SERVER_IP` 替换成实际 SSH 用户和服务器地址：

```sh
scp -r ./video-library YOUR_USER@YOUR_SERVER_IP:~/
ssh YOUR_USER@YOUR_SERVER_IP
```

在 Debian 上进入刚上传的文件夹：

```sh
cd ~/video-library
node --version
command -v node
```

确认 Node 主版本为 20 或更高。记录 `command -v node` 的结果，后面配置 `ExecStart` 时需要用到。

## 2. 创建运行用户并安装文件

```sh
getent passwd video-library >/dev/null || sudo useradd \
  --system --user-group \
  --home-dir /opt/video-library --no-create-home \
  --shell /usr/sbin/nologin video-library

sudo install -d -o root -g root -m 0755 /opt/video-library
sudo install -m 0644 server.mjs package.json README.md DEPLOY_DEBIAN.md /opt/video-library/
sudo cp -R public deploy tests /opt/video-library/
sudo chown -R root:root /opt/video-library/public /opt/video-library/deploy /opt/video-library/tests
sudo chmod -R u=rwX,go=rX /opt/video-library/public /opt/video-library/deploy /opt/video-library/tests

sudo install -d -o video-library -g video-library -m 0750 /opt/video-library/videos
sudo cp -R videos/. /opt/video-library/videos/
sudo chown -R video-library:video-library /opt/video-library/videos
sudo chmod -R u=rwX,g=rX,o= /opt/video-library/videos
```

`videos/` 中有素材时会一并复制；没有素材也可以直接启动，以后通过网页上传。

最终结构：

```text
/opt/video-library/
├── server.mjs
├── package.json
├── public/
├── deploy/
├── tests/
└── videos/
    ├── selena/
    │   └── 20260813_60.mp4
    └── granada/
        └── 20261020_clip.mp4
```

## 3. 安装环境配置与 service

以下环境文件复制命令用于首次安装。后续更新代码时保留已有的 `/etc/default/video-library`。

```sh
sudo install -m 0644 deploy/video-library.env.example /etc/default/video-library
sudo install -m 0644 deploy/video-library.service /etc/systemd/system/video-library.service
sudo nano /etc/default/video-library
```

默认配置：

```ini
NODE_ENV=production
HOST=0.0.0.0
PORT=8876
VIDEO_DIR=/opt/video-library/videos
TZ=Asia/Shanghai
MAX_UPLOAD_BYTES=2147483648
ALLOWED_HOSTS=
```

- `HOST=0.0.0.0`：监听服务器所有 IPv4 网卡。
- `PORT`：访问端口，可以更换为未占用的端口。
- `TZ`：上传时「今天」使用的时区。
- `MAX_UPLOAD_BYTES`：单文件上传上限，默认 2 GiB，最多 2147483648 字节。
- `ALLOWED_HOSTS`：额外允许访问的公网 IP 或域名。网卡自身的 IP 已自动允许；云服务器经过 NAT，或者使用域名访问时，请填写实际访问地址。

例如使用公网 IP `203.0.113.10` 和域名 `video.example.com` 时，改成下面这一行。这里是示例地址，需替换为自己的：

```ini
ALLOWED_HOSTS=203.0.113.10,video.example.com
```

只填写主机名或 IP，不填写 `http://`、端口、路径或 `*`。域名需要解析到服务器地址。此教程使用直接 HTTP 访问，浏览器地址为 `http://你的服务器地址:8876`。

然后确认 Node 路径：

```sh
sudo nano /etc/systemd/system/video-library.service
```

配置默认使用：

```ini
ExecStart=/usr/bin/node /opt/video-library/server.mjs
```

如果第一步查到 `/usr/local/bin/node`，将这一行改成：

```ini
ExecStart=/usr/local/bin/node /opt/video-library/server.mjs
```

使用实际路径验证运行用户可以执行 Node，例如：

```sh
sudo -u video-library /usr/bin/node --version
```

**如果 Node 通过 nvm 安装在 `/root` 或 `/home` 下：** systemd 不会加载交互式 shell 的 nvm 配置，本服务也启用了 `ProtectHome`。可以复制当前已有的 Node 可执行文件到专用的系统位置：

```sh
sudo install -D -o root -g root -m 0755 \
  "$(readlink -f "$(command -v node)")" \
  /opt/video-library-node/bin/node
sudo -u video-library /opt/video-library-node/bin/node --version
```

确认命令成功后，将 service 的 `ExecStart` 改成：

```ini
ExecStart=/opt/video-library-node/bin/node /opt/video-library/server.mjs
```

以后升级 nvm 中的 Node 时，需要重新复制这个文件，再重启服务。

## 4. 启动并设置开机自启

```sh
sudo systemd-analyze verify /etc/systemd/system/video-library.service
sudo systemctl daemon-reload
sudo systemctl enable --now video-library.service
sudo systemctl status video-library.service --no-pager
sudo systemctl is-enabled video-library.service
sudo systemctl is-active video-library.service
```

预期 `is-enabled` 输出 `enabled`，`is-active` 输出 `active`。`enable --now` 会同时设置开机启动并立即启动服务，之后不需要保持 SSH 会话连接。[systemctl 官方说明](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)

在服务器上检查 HTTP 接口：

```sh
curl --fail http://127.0.0.1:8876/api/library
```

能得到视频列表的 JSON 就说明 HTTP 服务正常。然后在电脑浏览器打开：

```text
http://你的服务器IP:8876
```

如果服务器本地访问正常、电脑访问超时，检查 Debian 防火墙和云平台安全组是否允许你所在网络访问 TCP 8876。

## 5. 常用维护命令

```sh
# 查看状态
sudo systemctl status video-library --no-pager

# 实时查看日志，Ctrl+C 只退出日志查看
sudo journalctl -u video-library -f

# 查看最近 100 行日志
sudo journalctl -u video-library -n 100 --no-pager

# 重启 / 停止 / 再次启动
sudo systemctl restart video-library
sudo systemctl stop video-library
sudo systemctl start video-library

# 取消开机自启，并停止当前服务
sudo systemctl disable --now video-library
```

服务异常退出后会等待 5 秒再尝试启动；60 秒内连续启动 5 次失败会暂停重试。修好配置后执行：

```sh
sudo systemctl reset-failed video-library
sudo systemctl restart video-library
```

正常执行 `systemctl stop` 会保持停止，不会被自动拉起。[systemd.service 官方说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Restart=)

## 6. 更新代码或素材

在服务器上进入新版本解压目录，复制代码时保留视频和环境配置：

```sh
cd ~/video-library
sudo systemctl stop video-library
sudo install -m 0644 server.mjs package.json README.md DEPLOY_DEBIAN.md /opt/video-library/
sudo cp -R public tests /opt/video-library/
sudo chown -R root:root /opt/video-library/public /opt/video-library/tests
sudo chmod -R u=rwX,go=rX /opt/video-library/public /opt/video-library/tests
sudo systemctl start video-library
```

更新前让正在进行的上传完成。只修改 `/etc/default/video-library` 时，执行 `systemctl restart video-library` 即可；修改 `.service` 后，需要先 `systemctl daemon-reload` 再重启。

以后手动复制素材后，应把这些素材交给运行用户读写，例如：

```sh
sudo chown -R video-library:video-library /opt/video-library/videos
sudo chmod -R u=rwX,g=rX,o= /opt/video-library/videos
```

在网页里点击刷新即可，无需重启。备份时保留 `/opt/video-library/videos`、`/etc/default/video-library` 和 `/etc/systemd/system/video-library.service`。

## 7. 常见问题

| 现象                          | 处理                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `203/EXEC`                    | 检查 `ExecStart` 的 Node 绝对路径，用 `sudo -u video-library /实际路径/node --version` 验证权限；nvm 路径按第三步处理。 |
| `217/USER`                    | 检查是否创建了 `video-library` 用户和同名组。                                                                           |
| `EADDRINUSE`                  | 端口被占用。在 `/etc/default/video-library` 修改 `PORT`，然后重启；访问时也使用新端口。                                 |
| `EACCES` / 上传提示服务器错误 | 检查视频目录的所有者和读写权限，并查看 `journalctl` 日志。                                                              |
| `此 Host 不允许访问`          | 将浏览器中使用的域名或公网 IP 加入 `ALLOWED_HOSTS`，然后重启；端口需与 `PORT` 一致。                                    |
| 本机能打开、外部超时          | 检查 `HOST=0.0.0.0`、服务器地址、防火墙和云安全组。                                                                     |
| `status` 显示启动太频繁       | 先修复日志里的错误，再运行 `reset-failed` 和 `restart`。                                                                |

如果将 `VIDEO_DIR` 改到其他目录，例如 `/srv/video-library/videos`，需要同时创建目录、授予 `video-library` 用户读写权限，并把 `.service` 的 `ReadWritePaths` 改到相同路径。这个目录不要放在 `/home` 或 `/root` 下，因为服务启用了 `ProtectHome`。[systemd.exec 官方说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)

此配置和教程已在本地检查；实际开机自启是否成功，以你的 Debian 上 `is-enabled`、`is-active` 和 HTTP 检查结果为准。
