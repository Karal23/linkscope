# 在公网部署 Linkscope

这个配置适合一台运行 systemd 的 Debian 或 Ubuntu 服务器。浏览器和探针访问同一个 HTTPS 域名。Nginx 处理 TLS 和限流，Waitress 在服务器回环地址的 4188 端口提供应用。生产状态目录独立于本地预览，初始拓扑为空。

## 安装面板

先将域名解析到服务器，并准备这个域名的证书和私钥。下列命令从仓库根目录运行，假设安装路径为 `/opt/linkscope`。首次部署时创建服务账户。

```sh
sudo apt-get install python3-venv nginx
sudo useradd --system --user-group --home-dir /var/lib/linkscope --shell /usr/sbin/nologin linkscope
sudo install -d /opt/linkscope /etc/linkscope
sudo install -d -o linkscope -g linkscope -m 0700 /var/lib/linkscope
sudo cp -a backend probes dist deploy /opt/linkscope/
sudo python3 -m venv /opt/linkscope/.venv
sudo /opt/linkscope/.venv/bin/pip install -r /opt/linkscope/deploy/requirements.txt
sudo -u linkscope /opt/linkscope/.venv/bin/python /opt/linkscope/backend/accounts.py admin --state /var/lib/linkscope
```

在 `/etc/linkscope/panel.env` 写入浏览器实际访问的来源。例如下面这一行，自定义端口也需写入。

```ini
LINKSCOPE_ORIGIN=https://monitor.example.com
```

要在拓扑固定显示浙江电信和浙江联通，在同一文件加一行 `LINKSCOPE_FIXED_INGRESS=zhejiang` 并重启 `linkscope.service`。把能执行 `ping` 的主机探针设为线路首跳后，它会自动领取两个地区反测任务。探针无需读取连接跟踪表。

`admin` 可看完整接入 IP、维护配置和改链。要创建只读账号，运行同一条设置密码命令，把 `admin` 改成 `viewer`。密码在终端交互输入。再次运行会更改该账号密码并使该账号的已有会话立即失效。登录会话最长 12 小时，点击「退出」会立即撤销当前会话。

```sh
sudo install -m 0644 deploy/linkscope.service /etc/systemd/system/
sudo install -m 0644 deploy/nginx.conf /etc/nginx/conf.d/linkscope.conf
sudoedit /etc/nginx/conf.d/linkscope.conf
sudo systemctl daemon-reload
sudo systemctl enable --now linkscope
sudo nginx -t && sudo systemctl reload nginx
```

在 Nginx 配置中替换示例域名和证书路径。浏览器打开配置的 HTTPS 域名即可看拓扑，进入「管理」时登录。登录接口按请求方 IP 限流，Nginx 的面板访问日志只记录路径、状态码、方法和耗时。使用已有反向代理时，保留原始 Host（含非默认端口），开启 HTTPS 并对登录接口限速。公网入口应转发到 4188 的鉴权服务。本地预览命令面向开发环境。

匿名访客和只读账号均可查看拓扑、指标和历史。服务端对接入 IP 使用带密钥的标识，隐藏配置中的节点探测地址、TCP 端口、测试代理及测试 URL。自行填写的节点名称、地区和服务商会公开展示。

## 接入第一台真实主机

1. 管理后台新建一个「主机探针」节点。服务器会创建 `/var/lib/linkscope/tokens/<节点 ID>`，节点页的「接入命令」已填好下面几步要用的节点 ID 和面板地址。
2. 在探针机安装 Python 3.10 以上。将仓库的 `probes/` 放到 `/opt/linkscope/probes/`。通过已有的 SSH 等加密通道分发该节点自己的凭据文件，在探针机保存为 `/etc/linkscope/tokens/<节点 ID>`，由 root 持有，权限 0600。
3. 在探针机的 `/etc/linkscope/probe.env` 中写入 `LINKSCOPE_URL=https://monitor.example.com`。安装服务并启动，将示例 ID `hk-01` 替换为后台的节点 ID。

   如果这台机器通过现有 SOCKS5 代理访问面板，给探针的 Python 环境安装 `urllib3` 和 `PySocks`，在同一文件另写一行 `LINKSCOPE_CONTROL_PROXY=socks5h://127.0.0.1:1081`。任务拉取和数据上报使用此代理，ICMP 和 TCP 分段仍从探针直接测量。

```sh
sudo install -m 0644 deploy/linkscope-agent@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now linkscope-agent@hk-01
sudo journalctl -u linkscope-agent@hk-01 -n 20 --no-pager
```

拓扑应出现真实心跳和网卡速率。分段测量在后台选择观测端、目标地址及方式。ICMP 需要探针机提供可供服务用户使用的 `ping`。面板根据服务器探针上报的各段延迟计算线路合计，启用固定浙江入口时还会计入所选运营商的反测。个人电脑可以关机。

轮换主机或测试端凭据时，在面板机运行以下命令，重新分发生成的文件，然后重启对应探针服务。命令只输出文件位置。

```sh
sudo -u linkscope /opt/linkscope/.venv/bin/python /opt/linkscope/backend/credentials.py --state /var/lib/linkscope rotate hk-01
```

## 来自不同地点的接入记录

采集家庭或移动客户端连接记录时，每个日志或连接适配器使用独立身份。先在管理后台建好真实线路，例如 `hk-main`，再为适配器授权。

```sh
sudo -u linkscope /opt/linkscope/.venv/bin/python /opt/linkscope/backend/credentials.py --state /var/lib/linkscope allow-access home --route hk-main
sudo -u linkscope /opt/linkscope/.venv/bin/python /opt/linkscope/backend/credentials.py --state /var/lib/linkscope allow-access mobile --route hk-main
```

把各自的 `tokens/access.home` 和 `tokens/access.mobile` 分发给对应适配器。以 `access.home` 为例，它用自己的 Bearer 凭据读取 `GET /api/v1/tasks?reporter=access.home`，取得授权线路的 `profiles`。向 `POST /api/v1/reports` 提交自己的 `sessions` 和 `routeVersions` 完整快照。空快照只清空该采集端。采集端凭据只允许会话上报，不返回线路测试代理。后台自动创建的主机探针采集网卡指标，具体代理软件的连接、地区和分线路流量需要由相应适配器提供。

再次运行 `allow-access` 可替换授权范围，多个线路重复写 `--route`。运行 `revoke-access home` 可撤销该采集端的凭据和当前快照。IPv4 和 IPv6 的历史样本及接入缓存保留 24 小时。

## 备份与恢复

公网状态目录包含账号校验值、探针凭据、接入标识密钥、拓扑、流量与历史。可在维护窗口暂停服务做完整备份，归档使用仅所有者可读的权限，转存到受保护的位置。

```sh
sudo systemctl stop linkscope
sudo sh -c 'umask 077; tar -czf "/var/backups/linkscope-$(date +%Y%m%d-%H%M%S).tar.gz" -C /var/lib linkscope'
sudo systemctl start linkscope
```

恢复演练时解压到单独的空目录，以服务账户打开该目录，用 `PRAGMA quick_check` 检查数据库，核对拓扑和 `tokens/`，再用独立回环端口及 HTTPS 测试站点验证登录、上报。恢复到新主机后重设面板账号密码可撤销归档中保存的旧会话。证书、反向代理配置和两个环境文件按服务器现有备份方式保存。

## 调整现有数据库的页大小

新库默认使用 2 KiB 页。已有实例可在维护时停止面板服务，用下面的工具备份数据库并调整页大小。备份应放在受限目录中，每次使用新文件名。迁移会验证备份、检查数据库完整性并恢复 WAL。

```sh
sudo systemctl stop linkscope.service
sudo python3 deploy/resize_sqlite.py --state /var/lib/linkscope --backup /var/backups/linkscope-before-2k.sqlite3
sudo systemctl start linkscope.service
```

要恢复原页大小，在相同的维护步骤中指定 `--page-size 4096`（或原值）和另一个备份文件名。工具会重排当时的数据库，保留迁移后收到的测量与用量。
