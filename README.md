
# Workers-Analytics
用于cloudflare的脚本数据统计

复制-粘贴脚本，按需修改相关内容

建立任意名称的KV空间

绑定KV空间，变量名称：NODE_MONITOR

CF控制台的设置里添加触发事件，Cron触发器按需添加计划

一次部署尽量不要超过30个脚本的检测，有可能会爆KV的并发限制，脚本多的话建议多账号部署

跟随cloudflare策略，北京时间每日8点清零

<img width="1358" height="819" alt="image" src="https://github.com/user-attachments/assets/71d643d1-3082-4c42-816e-1a3603692f92" />


