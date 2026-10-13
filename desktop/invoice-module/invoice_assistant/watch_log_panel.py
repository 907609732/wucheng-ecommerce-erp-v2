"""Expandable log viewer shared by the local monitoring window."""
from PySide6.QtCore import QTimer, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QApplication, QCheckBox, QHBoxLayout, QLabel,
                              QLineEdit, QPlainTextEdit, QPushButton, QVBoxLayout, QWidget)
from .watch_logs import diagnostic_report, export_report, format_logs, read_logs


class LogPanel(QWidget):
    def __init__(self, root, parent=None):
        super().__init__(parent)
        self.root = root
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.toggle = QPushButton("展开运行日志 · 排查报错 ▾")
        self.toggle.setStyleSheet("QPushButton {background:#e8eef9;color:#2454a3;}")
        self.toggle.setCheckable(True)
        layout.addWidget(self.toggle)
        self.body = QWidget()
        body = QVBoxLayout(self.body)
        body.setContentsMargins(0, 4, 0, 0)
        filters = QHBoxLayout()
        self.errors = QCheckBox("只看报错")
        self.search = QLineEdit()
        self.search.setPlaceholderText("搜索错误原因、错误码或任务编号")
        filters.addWidget(self.errors)
        filters.addWidget(self.search)
        body.addLayout(filters)
        self.viewer = QPlainTextEdit()
        self.viewer.setReadOnly(True)
        self.viewer.setMaximumBlockCount(500)
        self.viewer.setMinimumHeight(110)
        self.viewer.setMaximumHeight(160)
        self.viewer.setStyleSheet("QPlainTextEdit {background:white;border:1px solid #dce3ee;font:12px 'Consolas','Microsoft YaHei';padding:6px;}")
        self.viewer.setPlaceholderText("尚无符合筛选的运行日志。旧版历史结果不会补造详细日志。")
        body.addWidget(self.viewer)
        actions = QHBoxLayout()
        self.copy = QPushButton("复制诊断日志")
        self.export = QPushButton("导出诊断日志")
        self.folder = QPushButton("打开日志目录")
        for button in (self.copy, self.export, self.folder):
            actions.addWidget(button)
        body.addLayout(actions)
        self.status = QLabel("实时刷新；显示最近 500 条，复制/导出最近最多 2000 条符合筛选的日志。")
        self.status.setWordWrap(True)
        body.addWidget(self.status)
        layout.addWidget(self.body)
        self.body.hide()
        self.toggle.toggled.connect(self.expand)
        self.errors.toggled.connect(self.refresh)
        self.search.textChanged.connect(self.refresh)
        self.copy.clicked.connect(self.copy_report)
        self.export.clicked.connect(self.export_report)
        self.folder.clicked.connect(lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.root))))
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh)
        self.timer.start(1000)
        self.last_text = None

    def filters(self):
        return {"errors_only": self.errors.isChecked(), "keyword": self.search.text()}

    def expand(self, checked):
        self.body.setVisible(checked)
        self.toggle.setText("收起运行日志 ▴" if checked else "展开运行日志 · 排查报错 ▾")
        if checked:
            self.refresh()

    def refresh(self, *_):
        if not self.toggle.isChecked():
            return
        try:
            text = format_logs(read_logs(self.root, **self.filters()))
            if text != self.last_text:
                bar = self.viewer.verticalScrollBar()
                following = bar.value() >= bar.maximum() - 2
                position = bar.value()
                self.viewer.setPlainText(text)
                bar.setValue(bar.maximum() if following else position)
                self.last_text = text
        except Exception:
            self.status.setText("日志暂时不可读，请稍后重试；检查数量不能由日志缺失推断为零。")

    def copy_report(self):
        try:
            QApplication.clipboard().setText(diagnostic_report(self.root, **self.filters()))
            self.status.setText("诊断日志已复制，可粘贴给技术支持；不会自动上传。")
        except Exception:
            self.status.setText("复制失败，请检查本地日志目录权限后重试。")

    def export_report(self):
        try:
            path = export_report(self.root, **self.filters())
            self.status.setText("已导出：" + str(path))
        except Exception:
            self.status.setText("导出失败，请检查本地目录权限或磁盘空间后重试。")
