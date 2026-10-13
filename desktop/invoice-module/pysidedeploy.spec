[app]

# title of your application
title = InvoiceAssistant

# project directory. the general assumption is that project_dir is the parent directory
# of input_file
project_dir = C:\Users\90760\WorkBuddy\自动开发票

# source file path
input_file = C:\Users\90760\WorkBuddy\自动开发票\assistant.py

# directory where the executable output is generated
exec_directory = release

# path to .pyproject project file
project_file =

# application icon
icon = C:\Users\90760\AppData\Local\Programs\Python\Python312\Lib\site-packages\PySide6\scripts\deploy_lib\pyside_icon.ico

[python]

# python path
python_path = C:\Users\90760\AppData\Local\Programs\Python\Python312\python.exe

# python packages to install
packages = Nuitka==2.8.10,ordered-set,zstandard

# buildozer = for deploying Android application
android_packages = buildozer==1.5.0,cython==0.29.33

[qt]

# comma separated path to qml files required
# normally all the qml files required by the project are added automatically
qml_files = invoice_assistant\Main.qml

# excluded qml plugin binaries
excluded_qml_plugins = QtCharts,QtQuick3D,QtSensors,QtTest,QtWebEngine

# qt modules used. comma separated
modules = Core,QuickControls2,Quick,Qml,Gui,Widgets

# qt plugins used by the application. only relevant for desktop deployment. for qt plugins used
# in android application see [android][plugins]
plugins = platformthemes,styles,platforms,xcbglintegrations,platforminputcontexts,generic,qmltooling,imageformats,accessiblebridge,egldeviceintegrations,iconengines,scenegraph,platforms/darwin

[android]

# path to pyside wheel
wheel_pyside =

# path to shiboken wheel
wheel_shiboken =

# plugins to be copied to libs folder of the packaged application. comma separated
plugins =

[nuitka]

# usage description for permissions requested by the app as found in the info.plist file
# of the app bundle
# eg = extra_args = --show-modules --follow-stdlib
macos.permissions =

# mode of using nuitka. accepts standalone or onefile. default is onefile.
mode = standalone

# (str) specify any extra nuitka arguments
extra_args = --noinclude-qt-translations --assume-yes-for-downloads --msvc=latest --include-package=invoice_assistant --include-package=src --include-data-files=invoice_assistant/Main.qml=invoice_assistant/Main.qml --include-data-files=模板/新福通通用开票申请单模板.xlsx=模板/新福通通用开票申请单模板.xlsx --include-data-files=config.yaml=config.yaml --include-package-data=playwright --windows-console-mode=disable

[buildozer]

# build mode
# possible options = [release, debug]
# release creates an aab, while debug creates an apk
mode = debug

# contrains path to pyside6 and shiboken6 recipe dir
recipe_dir =

# path to extra qt android jars to be loaded by the application
jars_dir =

# if empty uses default ndk path downloaded by buildozer
ndk_path =

# if empty uses default sdk path downloaded by buildozer
sdk_path =

# other libraries to be loaded. comma separated.
# loaded at app startup
local_libs =

# architecture of deployed platform
# possible values = ["aarch64", "armv7a", "i686", "x86_64"]
arch =
