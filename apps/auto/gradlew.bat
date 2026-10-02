@rem Copyright 2015 the original author or authors.
@rem Licensed under the Apache License, Version 2.0.
@rem https://www.apache.org/licenses/LICENSE-2.0
@if "%DEBUG%"=="" @echo off
if "%OS%"=="Windows_NT" setlocal
set APP_HOME=%~dp0
set DEFAULT_JVM_OPTS="-Xmx64m" "-Xms64m"
if defined JAVA_HOME (
    set JAVA_EXE=%JAVA_HOME%/bin/java.exe
) else (
    set JAVA_EXE=java.exe
)
"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=gradlew" -classpath "%APP_HOME%\gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
exit /b %ERRORLEVEL%
